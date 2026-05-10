import type { PgClient } from '../db/client.ts';

export type ExpireAdsResult = { expired: number };

/**
 * Hourly transition of approved ads whose ends_at is in the past.
 * DM-to-sponsor on expiration is intentionally out of scope (issue #34);
 * the ad-replacement DM that does exist runs on the force-end admin action,
 * not on natural expiration.
 */
export async function expireAds(client: PgClient): Promise<ExpireAdsResult> {
  const res = await client.query(
    `UPDATE ads
        SET status = 'expired'
      WHERE status = 'approved'
        AND ends_at IS NOT NULL
        AND ends_at < now()`,
  );
  return { expired: res.rowCount ?? 0 };
}
