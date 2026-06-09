import type { PgClient } from '../../db/client.ts';
import {
  applyEffectiveWeights,
  approvePendingWithinBudget,
  getSponsorActiveRegularAllocs,
  insertReviewLog,
} from '../../db/queries/review.ts';
import { effectiveWeights } from '../../sponsors/tier.ts';

export type ApproveResult =
  | { ok: true; weightSnapshot: number; startsAt: Date }
  | { ok: false; reason: 'not_found' | 'no_sponsor' | 'no_tier' | 'race' | 'budget_exceeded' };

type AdLookup = {
  sponsorId: string | null;
  status: string;
  weight: number | null; // tiers.weight via JOIN
  weightAlloc: number; // this ad's intended alloc (NULL coerced to 1)
};

async function lookupAdAndTierWeight(client: PgClient, adId: string): Promise<AdLookup | null> {
  const res = await client.query<{
    sponsor_id: string | null;
    status: string;
    weight: number | null;
    weight_alloc: number | null;
  }>(
    `SELECT a.sponsor_id, a.status, a.weight_alloc, t.weight
       FROM ads a
       LEFT JOIN sponsors s ON s.discord_user_id = a.sponsor_id
       LEFT JOIN tiers t ON t.id = s.current_tier_id
      WHERE a.id = ?
      LIMIT 1`,
    [adId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    sponsorId: row.sponsor_id,
    status: row.status,
    weight: row.weight,
    weightAlloc: row.weight_alloc ?? 1,
  };
}

/**
 * Approve a pending ad. D1/SQLite has no interactive transactions or row locks
 * (the Workers D1 client makes BEGIN/COMMIT effectively no-ops), so the budget
 * invariant is enforced with an atomic single-statement conditional UPDATE
 * (`approvePendingWithinBudget`) rather than a read-then-write under a tx. The
 * pending row already reserved its budget at submit time, so the guarded flip
 * only fails (`budget_exceeded`) if the tier shrank since then. After the flip we
 * derive the sponsor's effective deck weights via `effectiveWeights` (the single
 * source of truth shared with the cron) and persist them; the persisted starts_at
 * is read back so the caller doesn't drift from the wall clock.
 */
export async function approveAd(
  client: PgClient,
  adId: string,
  reviewerId: string,
): Promise<ApproveResult> {
  // D1 has no interactive transactions or row locks, so we do NOT wrap this in
  // BEGIN/COMMIT (those are no-ops on the Workers D1 client and would be
  // misleading). Concurrency safety comes from the single-statement atomic
  // conditional UPDATE in approvePendingWithinBudget.
  const lookup = await lookupAdAndTierWeight(client, adId);
  if (!lookup) return { ok: false, reason: 'not_found' };
  if (!lookup.sponsorId) return { ok: false, reason: 'no_sponsor' };
  if (lookup.weight === null) return { ok: false, reason: 'no_tier' };

  // Atomic, budget-guarded flip pending -> approved. pending already reserved
  // budget at submit time, so this only fails if the tier shrank since then.
  const outcome = await approvePendingWithinBudget(
    client,
    adId,
    lookup.sponsorId,
    lookup.weightAlloc,
    reviewerId,
  );
  if (outcome === 'budget_exceeded') return { ok: false, reason: 'budget_exceeded' };
  if (outcome === 'race') return { ok: false, reason: 'race' };

  // The flip pending->approved is now COMMITTED. D1/SQLite has no interactive
  // transactions or rollback, so we can no longer "undo" this write. Every
  // post-flip side effect must therefore be best-effort: a throw here must NOT
  // propagate, or the button handler would never send its success response and
  // the 承認/却下 buttons would stay stuck on the message (a re-click would then
  // hit 'race'). So we always fall through to `return { ok: true, ... }`.
  let weightSnapshot = lookup.weightAlloc ?? 0;
  let startsAt = new Date();

  // 1) Derive + persist effective deck weights for the whole sponsor so the newly
  // approved banner and its siblings stay consistent. S <= T here (the guard
  // held), so no pause; this is the single source of truth shared with the cron.
  // If it throws, fall back to writing THIS ad's own alloc as its snapshot so it
  // still serves (the budget guard already ensured the alloc fits; the nightly
  // cron reconciles the siblings).
  try {
    const allocs = await getSponsorActiveRegularAllocs(client, lookup.sponsorId);
    const eff = effectiveWeights(allocs, lookup.weight);
    await applyEffectiveWeights(client, eff.weights, eff.paused);
    const mine = eff.weights.find((w) => w.id === adId);
    weightSnapshot = mine?.weightSnapshot ?? weightSnapshot;
  } catch (err) {
    console.error('approveAd: effective-weight recompute failed; falling back', adId, err);
    weightSnapshot = lookup.weightAlloc ?? 0;
    try {
      await client.query('UPDATE ads SET weight_snapshot = ? WHERE id = ?', [weightSnapshot, adId]);
    } catch (err2) {
      console.error('approveAd: fallback weight_snapshot write failed', adId, err2);
    }
  }

  // 2) Read back the persisted starts_at so the caller doesn't drift from the wall
  // clock (best-effort; fall back to the default `startsAt` above).
  try {
    const startsRes = await client.query<{ starts_at: Date }>(
      'SELECT starts_at FROM ads WHERE id = ?',
      [adId],
    );
    startsAt = startsRes.rows[0]?.starts_at ?? startsAt;
  } catch (err) {
    console.error('approveAd: SELECT starts_at failed; using default', adId, err);
  }

  // 3) Review log (best-effort): a missing audit row must not strand the buttons.
  try {
    await insertReviewLog(client, adId, reviewerId, 'approved', null);
  } catch (err) {
    console.error('approveAd: insertReviewLog failed (ad already approved)', adId, err);
  }

  return { ok: true, weightSnapshot, startsAt };
}
