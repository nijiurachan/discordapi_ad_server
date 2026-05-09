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
    const client = mockClient([{ rows: [] }], captured);
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    // Only the lookup query ran — no UPDATE / INSERT.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/FROM ads a/);
  });

  it('returns no_sponsor when sponsor_id is null', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ sponsor_id: null, status: 'pending', weight: 5 }] }],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'no_sponsor' });
    expect(captured).toHaveLength(1);
  });

  it('returns no_tier when sponsor has no current_tier_id (weight is null)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: null }] }],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'no_tier' });
    expect(captured).toHaveLength(1);
  });

  it('returns race when optimistic UPDATE finds no pending row', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7 }] },
        { rows: [], rowCount: 0 }, // already moved by another reviewer
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'race' });
    // Lookup + UPDATE attempted, no INSERT.
    expect(captured).toHaveLength(2);
    expect(captured.every((c) => !/INSERT INTO review_logs/.test(c.sql))).toBe(true);
  });

  it('happy path: returns weightSnapshot, updates with weight_snapshot + starts_at, logs approved', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7 }] },
        { rows: [], rowCount: 1 },
        { rows: [] },
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: true, weightSnapshot: 7 });

    // Lookup query ran with adId.
    expect(captured[0]?.sql).toMatch(/FROM ads a/);
    expect(captured[0]?.params).toEqual([AD_ID]);

    // UPDATE was called: pending guard, target=approved, weight_snapshot=7, reviewer captured.
    const update = captured.find((c) => /UPDATE ads SET/.test(c.sql));
    expect(update).toBeDefined();
    expect(update?.sql).toMatch(/starts_at = now\(\)/);
    expect(update?.sql).toMatch(/weight_snapshot = \$/);
    // params[0]=adId, params[1]=fromStatus 'pending', params[2]=newStatus 'approved'
    expect(update?.params?.[0]).toBe(AD_ID);
    expect(update?.params?.[1]).toBe('pending');
    expect(update?.params?.[2]).toBe('approved');
    expect(update?.params).toContain(REVIEWER_ID);
    expect(update?.params).toContain(7);

    // INSERT into review_logs with action='approved' and reason=null.
    const logInsert = captured.find((c) => /INSERT INTO review_logs/.test(c.sql));
    expect(logInsert).toBeDefined();
    expect(logInsert?.params).toEqual([AD_ID, REVIEWER_ID, 'approved', null]);
  });

  it('treats weight=0 as a valid frozen snapshot (not no_tier)', async () => {
    // Defensive: weight=0 should still be considered a tier (only NULL means missing).
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 0 }] },
        { rows: [], rowCount: 1 },
        { rows: [] },
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: true, weightSnapshot: 0 });
  });
});
