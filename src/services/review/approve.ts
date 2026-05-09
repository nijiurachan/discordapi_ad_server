import type { PgClient } from '../../db/client.ts';
import { insertReviewLog, updateAdStatusOptimistic } from '../../db/queries/review.ts';

export type ApproveResult =
  | { ok: true; weightSnapshot: number }
  | { ok: false; reason: 'not_found' | 'no_sponsor' | 'no_tier' | 'race' };

type AdLookup = {
  sponsorId: string | null;
  status: string;
  weight: number | null; // tiers.weight via JOIN
};

async function lookupAdAndTierWeight(client: PgClient, adId: string): Promise<AdLookup | null> {
  const res = await client.query<{
    sponsor_id: string | null;
    status: string;
    weight: number | null;
  }>(
    `SELECT a.sponsor_id, a.status, t.weight
       FROM ads a
       LEFT JOIN sponsors s ON s.discord_user_id = a.sponsor_id
       LEFT JOIN tiers t ON t.id = s.current_tier_id
      WHERE a.id = $1
      LIMIT 1`,
    [adId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { sponsorId: row.sponsor_id, status: row.status, weight: row.weight };
}

/**
 * Approve a pending ad. Freezes the sponsor's current Tier weight onto the ad row,
 * sets starts_at=now(), and inserts a review_logs entry.
 * Uses optimistic concurrency (status='pending' guard) to prevent double-approve.
 */
export async function approveAd(
  client: PgClient,
  adId: string,
  reviewerId: string,
): Promise<ApproveResult> {
  const lookup = await lookupAdAndTierWeight(client, adId);
  if (!lookup) return { ok: false, reason: 'not_found' };
  if (!lookup.sponsorId) return { ok: false, reason: 'no_sponsor' };
  if (lookup.weight === null) return { ok: false, reason: 'no_tier' };

  const update = await updateAdStatusOptimistic(client, adId, 'pending', {
    status: 'approved',
    reviewedBy: reviewerId,
    startsAt: 'now',
    weightSnapshot: lookup.weight,
  });
  if (!update.ok) return { ok: false, reason: 'race' };

  await insertReviewLog(client, adId, reviewerId, 'approved', null);
  return { ok: true, weightSnapshot: lookup.weight };
}
