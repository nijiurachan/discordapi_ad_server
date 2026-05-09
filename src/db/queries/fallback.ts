import type { PgClient } from '../client.ts';

export type FallbackRow = {
  id: string;
  adId: string;
  sponsorId: string;
  channelId: string;
  createdAt: Date;
  expiresAt: Date;
  acknowledgedAt: Date | null;
};

type FallbackDbRow = {
  id: string;
  ad_id: string;
  sponsor_id: string;
  channel_id: string;
  created_at: Date;
  expires_at: Date;
  acknowledged_at: Date | null;
};

function mapRow(r: FallbackDbRow): FallbackRow {
  return {
    id: r.id,
    adId: r.ad_id,
    sponsorId: r.sponsor_id,
    channelId: r.channel_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acknowledgedAt: r.acknowledged_at,
  };
}

export async function findActiveFallback(
  client: PgClient,
  adId: string,
): Promise<FallbackRow | null> {
  const res = await client.query<FallbackDbRow>(
    `SELECT id, ad_id, sponsor_id, channel_id, created_at, expires_at, acknowledged_at
       FROM dm_fallback_channels
      WHERE ad_id = $1
        AND acknowledged_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [adId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return mapRow(r);
}

export async function createFallbackRow(
  client: PgClient,
  args: {
    id: string;
    adId: string;
    sponsorId: string;
    channelId: string;
    expiresAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dm_fallback_channels (id, ad_id, sponsor_id, channel_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [args.id, args.adId, args.sponsorId, args.channelId, args.expiresAt],
  );
}

export type FallbackById = FallbackRow;

export async function findFallbackById(
  client: PgClient,
  fallbackId: string,
): Promise<FallbackById | null> {
  const res = await client.query<FallbackDbRow>(
    `SELECT id, ad_id, sponsor_id, channel_id, created_at, expires_at, acknowledged_at
       FROM dm_fallback_channels
      WHERE id = $1
      LIMIT 1`,
    [fallbackId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return mapRow(r);
}

export async function markFallbackAcknowledged(
  client: PgClient,
  fallbackId: string,
): Promise<void> {
  await client.query(
    'UPDATE dm_fallback_channels SET acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL',
    [fallbackId],
  );
}
