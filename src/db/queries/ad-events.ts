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

/**
 * Atomically insert an ad event if no recent matching event exists.
 *
 * The recency check + insert run as a single INSERT ... SELECT ... WHERE NOT
 * EXISTS, but under PostgreSQL's default READ COMMITTED isolation two
 * concurrent transactions can both evaluate WHERE NOT EXISTS as true (since
 * neither has committed yet) and both insert — defeating dedup. We serialise
 * concurrent attempts on the same (ad_id, ip_hash, event_type) tuple via a
 * per-key transaction-scoped advisory lock. The lock is released
 * automatically on COMMIT/ROLLBACK.
 *
 * Returns { ok: false, reason: 'duplicate' } when the dedup window suppresses
 * the insert.
 */
export async function insertEventIfNotRecent(
  client: PgClient,
  args: InsertAdEventArgs,
  windowMs: number = 5 * 60 * 1000,
): Promise<InsertEventResult> {
  const intervalSeconds = Math.max(1, Math.round(windowMs / 1000));
  // Pipe is safe as a separator: adId is a UUID and ipHash is hex, neither
  // contains a pipe naturally.
  const lockKey = `${args.adId}|${args.ipHash}|${args.eventType}`;

  await client.query('BEGIN');
  try {
    // hashtextextended(text, bigint seed) returns bigint, exactly what
    // pg_advisory_xact_lock(bigint) wants. Computing the hash server-side
    // means the worker doesn't need its own 64-bit hash function.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

    const res = await client.query<{ id: string }>(
      `INSERT INTO ad_events (ad_id, event_type, ip_hash, ua, slot)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (
          SELECT 1 FROM ad_events
           WHERE ad_id = $1
             AND ip_hash = $3
             AND event_type = $2
             AND ts > now() - make_interval(secs => $6)
        )
       RETURNING id::text`,
      [args.adId, args.eventType, args.ipHash, args.ua, args.slot, intervalSeconds],
    );

    await client.query('COMMIT');

    const row = res.rows[0];
    if (!row) return { ok: false, reason: 'duplicate' };
    return { ok: true, insertedId: BigInt(row.id) };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}
