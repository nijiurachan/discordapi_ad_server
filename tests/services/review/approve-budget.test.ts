import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import {
  applyEffectiveWeights,
  getSponsorActiveRegularAllocs,
} from '../../../src/db/queries/review.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };
function mockClient(
  responses: Array<{ rows: unknown[]; rowCount?: number }>,
  captured: CapturedCall[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++];
      if (!r) return { rows: [], rowCount: 0 };
      return { rowCount: r.rowCount ?? r.rows.length, ...r };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('getSponsorActiveRegularAllocs', () => {
  it('returns {id, weightAlloc} for pending+approved regular non-admin ads', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        {
          rows: [
            { id: 'a', weight_alloc: 50 },
            { id: 'b', weight_alloc: 20 },
          ],
        },
      ],
      captured,
    );
    const rows = await getSponsorActiveRegularAllocs(client, 'sp-1');
    expect(rows).toEqual([
      { id: 'a', weightAlloc: 50 },
      { id: 'b', weightAlloc: 20 },
    ]);
    expect(captured[0]?.params).toEqual(['sp-1']);
    expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
    expect(captured[0]?.sql).toMatch(/status IN \('pending', 'approved'\)/);
    expect(captured[0]?.sql).toMatch(/created_by_admin IS NULL/);
  });

  it('coerces NULL weight_alloc to 1 (legacy rows / default intent)', async () => {
    const client = mockClient([{ rows: [{ id: 'a', weight_alloc: null }] }]);
    const rows = await getSponsorActiveRegularAllocs(client, 'sp-1');
    expect(rows).toEqual([{ id: 'a', weightAlloc: 1 }]);
  });
});

describe('applyEffectiveWeights', () => {
  it('UPDATEs weight_snapshot per id and pauses the listed ids', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }, { rows: [] }, { rows: [] }], captured);
    await applyEffectiveWeights(
      client,
      [
        { id: 'a', weightSnapshot: 25 },
        { id: 'b', weightSnapshot: 10 },
      ],
      ['c'],
    );
    // two weight UPDATEs + one pause UPDATE
    const weightUpdates = captured.filter((c) => /SET weight_snapshot = \?/.test(c.sql));
    expect(weightUpdates).toHaveLength(2);
    expect(weightUpdates[0]?.params).toEqual([25, 'a']);
    expect(weightUpdates[1]?.params).toEqual([10, 'b']);
    const pause = captured.find((c) => /SET status = 'paused'/.test(c.sql));
    expect(pause?.params).toEqual(['c']);
  });

  it('skips the pause UPDATE when nothing is paused', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    await applyEffectiveWeights(client, [{ id: 'a', weightSnapshot: 5 }], []);
    expect(captured.some((c) => /SET status = 'paused'/.test(c.sql))).toBe(false);
  });
});

import { approvePendingWithinBudget } from '../../../src/db/queries/review.ts';

const AD = '11111111-1111-1111-1111-111111111111';

describe('approvePendingWithinBudget', () => {
  it('flips pending->approved and returns approved when budget fits (changes=1)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [], rowCount: 1 }], captured);
    const r = await approvePendingWithinBudget(client, AD, 'sp-1', 8, 'rev-1');
    expect(r).toBe('approved');
    // Single atomic statement: UPDATE ... SET status='approved' WHERE status='pending'
    // AND ((SUM over OTHER pending/approved regular non-admin allocs) + ?) <= tier weight.
    expect(captured).toHaveLength(1);
    const sql = captured[0]?.sql ?? '';
    expect(sql).toMatch(/UPDATE ads/);
    expect(sql).toMatch(/SET status = 'approved'/);
    expect(sql).toMatch(/status = 'pending'/);
    expect(sql).toMatch(/COALESCE\(SUM\(weight_alloc\), 0\)/);
    expect(sql).toMatch(/created_by_admin IS NULL/);
    expect(sql).toMatch(/status IN \('pending', 'approved'\)/);
    // params: [reviewerId, adId(for UPDATE WHERE), this ad's alloc, sponsorId, adId(SUM exclude)] etc.
    expect(captured[0]?.params).toContain(AD);
    expect(captured[0]?.params).toContain('sp-1');
    expect(captured[0]?.params).toContain(8);
  });

  it('returns budget_exceeded when the conditional UPDATE matches 0 rows and the ad is still pending', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [], rowCount: 0 }, // conditional UPDATE matched nothing
        { rows: [{ status: 'pending' }] }, // disambiguation read: still pending => budget
      ],
      captured,
    );
    const r = await approvePendingWithinBudget(client, AD, 'sp-1', 99, 'rev-1');
    expect(r).toBe('budget_exceeded');
  });

  it('returns race when the conditional UPDATE matches 0 rows and the ad is no longer pending', async () => {
    const client = mockClient([
      { rows: [], rowCount: 0 }, // conditional UPDATE matched nothing
      { rows: [{ status: 'approved' }] }, // already moved by another reviewer
    ]);
    const r = await approvePendingWithinBudget(client, AD, 'sp-1', 1, 'rev-1');
    expect(r).toBe('race');
  });

  it('returns race when the disambiguation read finds no row at all', async () => {
    const client = mockClient([
      { rows: [], rowCount: 0 },
      { rows: [] }, // row vanished
    ]);
    expect(await approvePendingWithinBudget(client, AD, 'sp-1', 1, 'rev-1')).toBe('race');
  });
});

import { approveAd } from '../../../src/services/review/approve.ts';

const AD_ID = '11111111-1111-1111-1111-111111111111';
const REVIEWER = 'rev-1';

describe('approveAd budget', () => {
  it('returns budget_exceeded when the atomic conditional UPDATE matches 0 rows (tier shrank)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        // lookup: sponsor + tier weight + this ad's alloc
        { rows: [{ sponsor_id: 'sp-1', status: 'pending', weight: 10, weight_alloc: 8 }] },
        // approvePendingWithinBudget: conditional UPDATE matches nothing
        { rows: [], rowCount: 0 },
        // disambiguation probe: ad still pending => budget, not race
        { rows: [{ status: 'pending' }] },
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER);
    expect(result).toEqual({ ok: false, reason: 'budget_exceeded' });
    // No effectiveWeights write and no COMMIT/BEGIN noise (D1 has no interactive tx).
    expect(captured.every((c) => !/SET weight_snapshot = \?/.test(c.sql))).toBe(true);
    expect(captured.every((c) => !/SET status = 'paused'/.test(c.sql))).toBe(true);
    expect(captured.every((c) => !/BEGIN ISOLATION LEVEL REPEATABLE READ/.test(c.sql))).toBe(true);
  });

  it('returns race when the atomic UPDATE matches 0 rows and the ad is no longer pending', async () => {
    const client = mockClient([
      { rows: [{ sponsor_id: 'sp-1', status: 'pending', weight: 10, weight_alloc: 1 }] }, // lookup
      { rows: [], rowCount: 0 }, // conditional UPDATE
      { rows: [{ status: 'approved' }] }, // already moved by another reviewer
    ]);
    const result = await approveAd(client, AD_ID, REVIEWER);
    expect(result).toEqual({ ok: false, reason: 'race' });
  });

  it('happy path: atomic approve, then writes effective weight_snapshot for the approved ad', async () => {
    const captured: CapturedCall[] = [];
    const startsAt = new Date('2026-06-08T00:00:00.000Z');
    const client = mockClient(
      [
        // lookup
        { rows: [{ sponsor_id: 'sp-1', status: 'pending', weight: 80, weight_alloc: 50 }] },
        // approvePendingWithinBudget conditional UPDATE -> 1 row (approved)
        { rows: [], rowCount: 1 },
        // getSponsorActiveRegularAllocs Σ=70 <= 80
        {
          rows: [
            { id: AD_ID, weight_alloc: 50 },
            { id: 'other', weight_alloc: 20 },
          ],
        },
        // applyEffectiveWeights UPDATE id=AD_ID
        { rows: [] },
        // applyEffectiveWeights UPDATE id=other
        { rows: [] },
        // SELECT starts_at
        { rows: [{ starts_at: startsAt }] },
        // INSERT review_logs
        { rows: [] },
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER);
    expect(result).toEqual({ ok: true, weightSnapshot: 50, startsAt });
    // The atomic approve UPDATE ran with status='approved' guard + SUM subquery.
    const approveUpdate = captured.find((c) => /SET status = 'approved'/.test(c.sql));
    expect(approveUpdate?.sql).toMatch(/COALESCE\(SUM\(weight_alloc\), 0\)/);
    expect(approveUpdate?.sql).toMatch(/starts_at = \(unixepoch/);
    expect(approveUpdate?.sql).not.toMatch(/now\(\)/);
    // effective weight_snapshot for this ad is its alloc (S<=T branch).
    const w = captured.find(
      (c) => /SET weight_snapshot = \?/.test(c.sql) && c.params?.[1] === AD_ID,
    );
    expect(w?.params?.[0]).toBe(50);
    // No Postgres tx control statements.
    expect(captured.every((c) => !/^BEGIN/.test(c.sql) && !/^COMMIT/.test(c.sql))).toBe(true);
  });
});
