import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { approveAd } from '../../../src/services/review/approve.ts';

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

const AD_ID = '11111111-1111-1111-1111-111111111111';
const REVIEWER_ID = 'reviewer-1';

describe('approveAd', () => {
  it('returns not_found when SELECT returns no row', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // lookup — no row
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    // Only the lookup ran; no UPDATE / INSERT.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/FROM ads a/);
    expect(captured.every((c) => !/UPDATE ads/.test(c.sql))).toBe(true);
    expect(captured.every((c) => !/INSERT INTO review_logs/.test(c.sql))).toBe(true);
  });

  it('returns no_sponsor when sponsor_id is null', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: null, status: 'pending', weight: 5, weight_alloc: 1 }] }, // lookup
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'no_sponsor' });
    expect(captured).toHaveLength(1);
  });

  it('returns no_tier when sponsor has no current_tier_id (weight is null)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: null, weight_alloc: 1 }] }, // lookup
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'no_tier' });
    expect(captured).toHaveLength(1);
  });

  it('returns race when the atomic UPDATE finds no pending row (no weight write, no INSERT)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7, weight_alloc: 1 }] }, // lookup
        { rows: [], rowCount: 0 }, // conditional UPDATE — already moved by another reviewer
        { rows: [{ status: 'approved' }] }, // disambiguation probe
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'race' });
    expect(captured.every((c) => !/SET weight_snapshot = \?/.test(c.sql))).toBe(true);
    expect(captured.every((c) => !/INSERT INTO review_logs/.test(c.sql))).toBe(true);
  });

  it('happy path: atomic approve, then writes effective weight_snapshot + persisted startsAt', async () => {
    const captured: CapturedCall[] = [];
    const persistedStartsAt = new Date('2026-05-09T12:34:56.000Z');
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7, weight_alloc: 7 }] }, // lookup
        { rows: [], rowCount: 1 }, // atomic approve UPDATE
        { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
        { rows: [] }, // applyEffectiveWeights UPDATE
        { rows: [{ starts_at: persistedStartsAt }] }, // SELECT starts_at
        { rows: [] }, // INSERT review_logs
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: true, weightSnapshot: 7, startsAt: persistedStartsAt });

    // Lookup query ran with adId.
    expect(captured[0]?.sql).toMatch(/FROM ads a/);
    expect(captured[0]?.params).toEqual([AD_ID]);

    // Atomic approve UPDATE: status='approved' guard + epoch-ms starts_at (not now()).
    const approveUpdate = captured.find((c) => /SET status = 'approved'/.test(c.sql));
    expect(approveUpdate).toBeDefined();
    expect(approveUpdate?.sql).toMatch(/starts_at = \(unixepoch/);
    expect(approveUpdate?.sql).not.toMatch(/now\(\)/);

    // weight_snapshot is written by a SEPARATE UPDATE from applyEffectiveWeights.
    const weightWrite = captured.find((c) => /UPDATE ads SET weight_snapshot = \?/.test(c.sql));
    expect(weightWrite).toBeDefined();
    expect(weightWrite?.params).toEqual([7, AD_ID]);

    // SELECT starts_at after UPDATE.
    const selectStarts = captured.find((c) => /SELECT starts_at FROM ads/.test(c.sql));
    expect(selectStarts).toBeDefined();
    expect(selectStarts?.params).toEqual([AD_ID]);

    // INSERT into review_logs with action='approved' and reason=null.
    const logInsert = captured.find((c) => /INSERT INTO review_logs/.test(c.sql));
    expect(logInsert).toBeDefined();
    expect(logInsert?.params).toEqual([AD_ID, REVIEWER_ID, 'approved', null]);

    if (result.ok) {
      expect(result.startsAt).toBeInstanceOf(Date);
    }
  });

  it('falls back to new Date() if SELECT starts_at unexpectedly returns no row', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7, weight_alloc: 7 }] }, // lookup
        { rows: [], rowCount: 1 }, // atomic approve UPDATE
        { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
        { rows: [] }, // applyEffectiveWeights UPDATE
        { rows: [] }, // SELECT starts_at (empty — defensive)
        { rows: [] }, // INSERT review_logs
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.weightSnapshot).toBe(7);
      expect(result.startsAt).toBeInstanceOf(Date);
    }
  });

  it('tier weight 0 rejects approval as budget_exceeded', async () => {
    // With the atomic guard, a tier weight of 0 cannot fit any alloc >= 1, so the
    // conditional UPDATE matches 0 rows and the still-pending probe => budget_exceeded.
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 0, weight_alloc: 1 }] }, // lookup
        { rows: [], rowCount: 0 }, // conditional UPDATE: (0 + 1) <= 0 is false
        { rows: [{ status: 'pending' }] }, // probe: still pending => budget
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'budget_exceeded' });
  });
});
