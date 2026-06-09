import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { approveAd } from '../../../src/services/review/approve.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

// A response can optionally carry a throw matcher: when the issued SQL matches,
// that query() call rejects (simulating a D1 failure mid side-effect). Throwing
// is keyed off the SQL pattern (not the positional index) so a thrown side
// effect doesn't desync the canned-response cursor for the calls that still run
// after it.
//   - `throwOn`:   rejects on EVERY matching call.
//   - `throwOnce`: rejects only on the FIRST matching call (so a guarded retry /
//                  fallback that issues the same SQL is allowed through).
type MockResponse = { rows: unknown[]; rowCount?: number; throwOn?: RegExp; throwOnce?: RegExp };

function mockClient(responses: MockResponse[], captured: CapturedCall[] = []): PgClient {
  const always = responses.filter((r) => r.throwOn).map((r) => r.throwOn as RegExp);
  const once = responses.filter((r) => r.throwOnce).map((r) => r.throwOnce as RegExp);
  const onceFired = new Set<RegExp>();
  const canned = responses.filter((r) => !r.throwOn && !r.throwOnce);
  let j = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      if (always.some((re) => re.test(sql))) {
        throw new Error(`mock D1 failure on: ${sql.slice(0, 40)}`);
      }
      const onceMatch = once.find((re) => !onceFired.has(re) && re.test(sql));
      if (onceMatch) {
        onceFired.add(onceMatch);
        throw new Error(`mock D1 failure (once) on: ${sql.slice(0, 40)}`);
      }
      const r = canned[j++];
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

  // Regression: the status flip pending->approved is already committed (D1 has no
  // rollback), so a failing post-flip side effect must NOT reject — otherwise the
  // button handler never clears the 承認/却下 buttons and a re-click hits 'race'.
  it('(a) recompute throws after flip succeeds: still ok:true, logs the review, and writes a fallback weight_snapshot', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7, weight_alloc: 7 }] }, // lookup
        { rows: [], rowCount: 1 }, // atomic approve UPDATE (committed)
        { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
        // The effective-weight write throws (simulates a D1 failure mid recompute).
        // The fallback UPDATE shares this SQL but is in its own try/catch, so the
        // 2nd matching call is allowed through below via throwOnce.
        { rows: [{ starts_at: new Date('2026-05-09T12:34:56.000Z') }] }, // SELECT starts_at
        { rows: [] }, // INSERT review_logs
        { rows: [], throwOnce: /UPDATE ads SET weight_snapshot = \?/ },
      ],
      captured,
    );
    const result = await approveAd(client, AD_ID, REVIEWER_ID);

    // Must resolve ok:true (does NOT reject) so the buttons get cleared.
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Fallback writes this ad's own alloc as its snapshot.
      expect(result.weightSnapshot).toBe(7);
      expect(result.startsAt).toBeInstanceOf(Date);
    }

    // review_logs INSERT was still issued (best-effort, must run).
    const logInsert = captured.find((c) => /INSERT INTO review_logs/.test(c.sql));
    expect(logInsert).toBeDefined();
    expect(logInsert?.params).toEqual([AD_ID, REVIEWER_ID, 'approved', null]);

    // A fallback `UPDATE ads SET weight_snapshot = ?` with this ad's weight_alloc
    // (and id) was issued so the banner still serves. (The first such write — from
    // applyEffectiveWeights — threw; this is the guarded fallback that followed.)
    const weightWrites = captured.filter((c) => /UPDATE ads SET weight_snapshot = \?/.test(c.sql));
    expect(weightWrites.length).toBeGreaterThanOrEqual(2);
    const fallbackWrite = weightWrites[weightWrites.length - 1];
    expect(fallbackWrite?.params).toEqual([7, AD_ID]);
  });

  it('(b) insertReviewLog throws after flip succeeds: still resolves ok:true', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7, weight_alloc: 7 }] }, // lookup
        { rows: [], rowCount: 1 }, // atomic approve UPDATE (committed)
        { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
        { rows: [] }, // applyEffectiveWeights UPDATE
        { rows: [{ starts_at: new Date('2026-05-09T12:34:56.000Z') }] }, // SELECT starts_at
        { rows: [], throwOn: /INSERT INTO review_logs/ }, // insertReviewLog throws
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
});
