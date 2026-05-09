import type { PgClient } from '../client.ts';

export type AdEventType = 'impression' | 'click';

export type InsertAdEventArgs = {
  adId: string;
  eventType: AdEventType;
  ipHash: string | null;
  ua: string | null;
  slot: string | null;
};

/**
 * Returns true if there's a matching ad_events row within `windowMs` for the
 * same (adId, ipHash, eventType). Used to dedupe rapid duplicate impressions
 * or click spam from the same client.
 */
export async function isRecentEvent(
  client: PgClient,
  adId: string,
  ipHash: string,
  eventType: AdEventType,
  windowMs: number = 5 * 60 * 1000,
): Promise<boolean> {
  const intervalSeconds = Math.max(1, Math.round(windowMs / 1000));
  const res = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ad_events
        WHERE ad_id = $1
          AND ip_hash = $2
          AND event_type = $3
          AND ts > now() - make_interval(secs => $4)
     ) AS "exists"`,
    [adId, ipHash, eventType, intervalSeconds],
  );
  return Boolean(res.rows[0]?.exists);
}

export async function insertAdEvent(client: PgClient, args: InsertAdEventArgs): Promise<void> {
  await client.query(
    `INSERT INTO ad_events (ad_id, event_type, ip_hash, ua, slot)
     VALUES ($1, $2, $3, $4, $5)`,
    [args.adId, args.eventType, args.ipHash, args.ua, args.slot],
  );
}
