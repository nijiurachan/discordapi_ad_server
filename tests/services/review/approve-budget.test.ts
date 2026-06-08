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
      [{ rows: [{ id: 'a', weight_alloc: 50 }, { id: 'b', weight_alloc: 20 }] }],
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
