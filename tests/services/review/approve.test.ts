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
    // Only the lookup query ran — no transaction, no UPDATE / INSERT.
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

  it('returns race when optimistic UPDATE finds no pending row (BEGIN → ROLLBACK, no INSERT)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7 }] },
        { rows: [] }, // BEGIN
        { rows: [], rowCount: 0 }, // UPDATE — already moved by another reviewer
        { rows: [] }, // ROLLBACK
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: false, reason: 'race' });
    // Lookup + BEGIN + UPDATE + ROLLBACK; no INSERT, no COMMIT.
    expect(captured).toHaveLength(4);
    expect(captured[1]?.sql).toMatch(/^BEGIN/);
    expect(captured[2]?.sql).toMatch(/UPDATE ads SET/);
    expect(captured[3]?.sql).toMatch(/^ROLLBACK/);
    expect(captured.every((c) => !/INSERT INTO review_logs/.test(c.sql))).toBe(true);
    expect(captured.every((c) => !/^COMMIT/.test(c.sql))).toBe(true);
  });

  it('happy path: returns weightSnapshot + persisted startsAt, brackets work in BEGIN/COMMIT', async () => {
    const captured: CapturedCall[] = [];
    const persistedStartsAt = new Date('2026-05-09T12:34:56.000Z');
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7 }] },
        { rows: [] }, // BEGIN
        { rows: [], rowCount: 1 }, // UPDATE
        { rows: [{ starts_at: persistedStartsAt }] }, // SELECT starts_at
        { rows: [] }, // INSERT review_logs
        { rows: [] }, // COMMIT
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: true, weightSnapshot: 7, startsAt: persistedStartsAt });

    // Lookup query ran with adId.
    expect(captured[0]?.sql).toMatch(/FROM ads a/);
    expect(captured[0]?.params).toEqual([AD_ID]);

    // BEGIN/COMMIT bracket the writes.
    expect(captured[1]?.sql).toMatch(/^BEGIN/);
    expect(captured[captured.length - 1]?.sql).toMatch(/^COMMIT/);

    // UPDATE was called: pending guard, target=approved, weight_snapshot=7, reviewer captured.
    const update = captured.find((c) => /UPDATE ads SET/.test(c.sql));
    expect(update).toBeDefined();
    expect(update?.sql).toMatch(/starts_at = now\(\)/);
    expect(update?.sql).toMatch(/weight_snapshot = \$/);
    expect(update?.params?.[0]).toBe(AD_ID);
    expect(update?.params?.[1]).toBe('pending');
    expect(update?.params?.[2]).toBe('approved');
    expect(update?.params).toContain(REVIEWER_ID);
    expect(update?.params).toContain(7);

    // SELECT starts_at after UPDATE.
    const selectStarts = captured.find((c) => /SELECT starts_at FROM ads/.test(c.sql));
    expect(selectStarts).toBeDefined();
    expect(selectStarts?.params).toEqual([AD_ID]);

    // INSERT into review_logs with action='approved' and reason=null.
    const logInsert = captured.find((c) => /INSERT INTO review_logs/.test(c.sql));
    expect(logInsert).toBeDefined();
    expect(logInsert?.params).toEqual([AD_ID, REVIEWER_ID, 'approved', null]);

    // Returned startsAt is a Date.
    if (result.ok) {
      expect(result.startsAt).toBeInstanceOf(Date);
    }
  });

  it('falls back to new Date() if SELECT starts_at unexpectedly returns no row', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7 }] },
        { rows: [] }, // BEGIN
        { rows: [], rowCount: 1 }, // UPDATE
        { rows: [] }, // SELECT starts_at (empty — defensive)
        { rows: [] }, // INSERT review_logs
        { rows: [] }, // COMMIT
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

  it('treats weight=0 as a valid frozen snapshot (not no_tier)', async () => {
    // Defensive: weight=0 should still be considered a tier (only NULL means missing).
    const captured: CapturedCall[] = [];
    const persistedStartsAt = new Date('2026-05-09T12:34:56.000Z');
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 0 }] },
        { rows: [] }, // BEGIN
        { rows: [], rowCount: 1 }, // UPDATE
        { rows: [{ starts_at: persistedStartsAt }] }, // SELECT starts_at
        { rows: [] }, // INSERT review_logs
        { rows: [] }, // COMMIT
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);
    expect(result).toEqual({ ok: true, weightSnapshot: 0, startsAt: persistedStartsAt });
  });
});
