import type { PgClient } from '../client.ts';
import type { AdKind, AdStatus } from './admin-ads.ts';

export type AdSnapshot = {
  id: string;
  sponsorId: string | null;
  kind: AdKind;
  status: AdStatus;
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
};

export async function getAdById(client: PgClient, adId: string): Promise<AdSnapshot | null> {
  const res = await client.query<{
    id: string;
    sponsor_id: string | null;
    kind: string;
    status: string;
    title: string;
    starts_at: Date | null;
    ends_at: Date | null;
  }>(
    `SELECT id, sponsor_id, kind, status, title, starts_at, ends_at
       FROM ads
      WHERE id = $1
      LIMIT 1`,
    [adId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sponsorId: row.sponsor_id,
    kind: row.kind as AdKind,
    status: row.status as AdStatus,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

export async function updateAdStatus(
  client: PgClient,
  adId: string,
  expectedStatus: AdStatus,
  newStatus: AdStatus,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE ads SET status = $1
       WHERE id = $2 AND status = $3`,
    [newStatus, adId, expectedStatus],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function forceEndAd(
  client: PgClient,
  adId: string,
  allowedStatuses: AdStatus[],
): Promise<boolean> {
  const placeholders = allowedStatuses.map((_, i) => `$${i + 2}`).join(',');
  const res = await client.query(
    `UPDATE ads
        SET status = 'expired',
            ends_at = now()
      WHERE id = $1 AND status IN (${placeholders})`,
    [adId, ...allowedStatuses],
  );
  return (res.rowCount ?? 0) > 0;
}
