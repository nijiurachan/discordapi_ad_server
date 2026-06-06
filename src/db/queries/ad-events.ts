import type { PgClient } from '../client.ts';

export type AdEventType = 'impression' | 'click';

export type InsertAdEventArgs = {
  adId: string;
  eventType: AdEventType;
  ipHash: string | null;
  ua: string | null;
  slot: string | null;
};

export type InsertEventResult =
  | { ok: true; insertedId: bigint }
  | { ok: false; reason: 'duplicate' };

/**
 * @deprecated Use insertEventIfNotRecent instead — race-free single statement.
 * Kept for explicit dedup-only checks (no insert).
 */
export async function isRecentEvent(
  client: PgClient,
  adId: string,
  ipHash: string,
  eventType: AdEventType,
  windowMs: number = 5 * 60 * 1000,
): Promise<boolean> {
  // SQLite has no make_interval(); compare against (now-windowMs) in epoch ms.
  const res = await client.query<{ exists: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM ad_events
        WHERE ad_id = ?
          AND ip_hash = ?
          AND event_type = ?
          AND ts > (unixepoch() * 1000) - ?
     ) AS "exists"`,
    [adId, ipHash, eventType, windowMs],
  );
  return Boolean(res.rows[0]?.exists);
}

export async function insertAdEvent(client: PgClient, args: InsertAdEventArgs): Promise<void> {
  await client.query(
    `INSERT INTO ad_events (ad_id, event_type, ip_hash, ua, slot)
     VALUES (?, ?, ?, ?, ?)`,
    [args.adId, args.eventType, args.ipHash, args.ua, args.slot],
  );
}

/**
 * Atomically insert an ad event if no recent matching event exists.
 *
 * Single INSERT ... SELECT ... WHERE NOT EXISTS statement. In D1 / SQLite the
 * database is single-shard with SERIALIZABLE-like isolation per statement, so
 * the read inside WHERE NOT EXISTS and the INSERT happen as one atomic step —
 * no advisory lock or transaction needed (unlike the original Postgres impl).
 *
 * Returns { ok: false, reason: 'duplicate' } when the dedup window suppresses
 * the insert.
 */
export async function insertEventIfNotRecent(
  client: PgClient,
  args: InsertAdEventArgs,
  windowMs: number = 5 * 60 * 1000,
): Promise<InsertEventResult> {
  // SQLite has no make_interval(); compare against (now - windowMs) in epoch ms.
  const res = await client.query<{ id: string | number }>(
    `INSERT INTO ad_events (ad_id, event_type, ip_hash, ua, slot)
     SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM ad_events
         WHERE ad_id = ?
           AND ip_hash = ?
           AND event_type = ?
           AND ts > (unixepoch() * 1000) - ?
      )
     RETURNING id`,
    [
      args.adId,
      args.eventType,
      args.ipHash,
      args.ua,
      args.slot,
      args.adId,
      args.ipHash,
      args.eventType,
      windowMs,
    ],
  );

  const row = res.rows[0];
  if (!row) return { ok: false, reason: 'duplicate' };
  return { ok: true, insertedId: BigInt(row.id) };
}
