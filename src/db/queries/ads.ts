import type { PgClient } from '../client.ts';

export type SponsorAd = {
  id: string;
  slot: string;
  title: string;
  body: string;
  linkUrl: string;
  imageKey: string | null;
  imageMime: string | null;
  status: string;
  weightSnapshot: number | null;
  createdAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
};

export async function getSponsorAds(
  client: PgClient,
  sponsorId: string,
  limit = 5,
): Promise<SponsorAd[]> {
  const res = await client.query<{
    id: string;
    slot: string;
    title: string;
    body: string;
    link_url: string;
    image_key: string | null;
    image_mime: string | null;
    status: string;
    weight_snapshot: number | null;
    created_at: Date;
    starts_at: Date | null;
    ends_at: Date | null;
  }>(
    `SELECT id, slot, title, body, link_url, image_key, image_mime,
            status, weight_snapshot, created_at, starts_at, ends_at
       FROM ads
      WHERE sponsor_id = ?
      ORDER BY
        CASE status
          WHEN 'pending'   THEN 1
          WHEN 'approved'  THEN 2
          WHEN 'paused'    THEN 3
          WHEN 'rejected'  THEN 4
          WHEN 'expired'   THEN 5
          WHEN 'withdrawn' THEN 6
          ELSE 7
        END,
        created_at DESC
      LIMIT ?`,
    [sponsorId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    slot: r.slot,
    title: r.title,
    body: r.body,
    linkUrl: r.link_url,
    imageKey: r.image_key,
    imageMime: r.image_mime,
    status: r.status,
    weightSnapshot: r.weight_snapshot,
    createdAt: r.created_at,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  }));
}

export type WithdrawResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_owner' | 'invalid_status' };

const WITHDRAWABLE_STATUSES = ['pending', 'approved', 'paused'] as const;

export async function withdrawAd(
  client: PgClient,
  sponsorId: string,
  adId: string,
): Promise<WithdrawResult> {
  await client.query('BEGIN');
  try {
    const lockRes = await client.query<{ sponsor_id: string | null; status: string }>(
      'SELECT sponsor_id, status FROM ads WHERE id = ?',
      [adId],
    );
    const row = lockRes.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (row.sponsor_id !== sponsorId) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_owner' };
    }
    if (!WITHDRAWABLE_STATUSES.includes(row.status as (typeof WITHDRAWABLE_STATUSES)[number])) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid_status' };
    }
    await client.query(
      `UPDATE ads
          SET status = 'withdrawn',
              ends_at = (unixepoch() * 1000)
        WHERE id = ?`,
      [adId],
    );
    await client.query(
      `INSERT INTO review_logs (ad_id, reviewer_id, action, reason)
       VALUES (?, ?, 'withdrawn', 'sponsor self-withdraw')`,
      [adId, sponsorId],
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignored */
    }
    throw err;
  }
}

export type AggregateStats = {
  impressions: number;
  clicks: number;
  ctr: number; // 0..1
  adCount: number;
};

export type StatsPeriod = '24h' | '7d' | '30d' | 'all';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PERIOD_MS: Record<StatsPeriod, number | null> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  all: null,
};

/**
 * Aggregates impressions/clicks/CTR for a sponsor over a rolling time window.
 *
 * Note: queries `ad_events` directly (not the daily-bucketed `ad_stats_daily`
 * view) because the `24h` / `7d` / `30d` periods are rolling windows from
 * `(unixepoch() * 1000)`, and the view's `date_trunc('day', ts)` would round to whole-day
 * buckets — losing intra-day events near the boundary.
 *
 * The view remains useful for genuine daily reports (admin dashboards in P6).
 */
export async function getAggregateStats(
  client: PgClient,
  sponsorId: string,
  period: StatsPeriod,
): Promise<AggregateStats> {
  const windowMs = PERIOD_MS[period];
  // Compute the rolling-window cutoff in JS — SQLite has no `interval` literal.
  // The cutoff is passed as a parameter so the SQL plan stays cacheable.
  const tsCondition = windowMs !== null ? 'AND e.ts >= ?' : '';
  const params: unknown[] = windowMs !== null ? [Date.now() - windowMs, sponsorId] : [sponsorId];
  const res = await client.query<{
    impressions: string;
    clicks: string;
    ad_count: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE e.event_type = 'impression') AS impressions,
       COUNT(*) FILTER (WHERE e.event_type = 'click')       AS clicks,
       COUNT(DISTINCT a.id)                                  AS ad_count
     FROM ads a
     LEFT JOIN ad_events e ON e.ad_id = a.id ${tsCondition}
     WHERE a.sponsor_id = ?
       AND a.kind <> 'placeholder'`,
    params,
  );
  const row = res.rows[0];
  const impressions = Number(row?.impressions ?? '0');
  const clicks = Number(row?.clicks ?? '0');
  const adCount = Number(row?.ad_count ?? '0');
  const ctr = impressions > 0 ? clicks / impressions : 0;
  return { impressions, clicks, ctr, adCount };
}
