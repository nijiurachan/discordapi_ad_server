import type { PgClient } from '../../db/client.ts';
import { insertReviewLog, updateAdStatusOptimistic } from '../../db/queries/review.ts';

export type ApproveResult =
  | { ok: true; weightSnapshot: number; startsAt: Date }
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
 * UPDATE + log INSERT run in a transaction; the persisted starts_at is read back
 * from the DB so the caller doesn't drift from the wall clock.
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

  await client.query('BEGIN');
  try {
    const update = await updateAdStatusOptimistic(client, adId, 'pending', {
      status: 'approved',
      reviewedBy: reviewerId,
      startsAt: 'now',
      weightSnapshot: lookup.weight,
    });
    if (!update.ok) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'race' };
    }

    const startsRes = await client.query<{ starts_at: Date }>(
      'SELECT starts_at FROM ads WHERE id = $1',
      [adId],
    );
    const startsAt = startsRes.rows[0]?.starts_at ?? new Date();

    await insertReviewLog(client, adId, reviewerId, 'approved', null);

    await client.query('COMMIT');
    return { ok: true, weightSnapshot: lookup.weight, startsAt };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}
