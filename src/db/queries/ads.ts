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
      WHERE sponsor_id = $1
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
      LIMIT $2`,
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
      'SELECT sponsor_id, status FROM ads WHERE id = $1 FOR UPDATE',
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
              ends_at = now()
        WHERE id = $1`,
      [adId],
    );
    await client.query(
      `INSERT INTO review_logs (ad_id, reviewer_id, action, reason)
       VALUES ($1, $2, 'withdrawn', 'sponsor self-withdraw')`,
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

const PERIOD_INTERVAL: Record<StatsPeriod, string | null> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  all: null,
};

export async function getAggregateStats(
  client: PgClient,
  sponsorId: string,
  period: StatsPeriod,
): Promise<AggregateStats> {
  const interval = PERIOD_INTERVAL[period];
  // The interval string is hardcoded against a known finite set above; it is
  // never user input, so inlining it into the SQL is safe.
  const tsCondition = interval ? `AND e.ts > now() - interval '${interval}'` : '';
  const res = await client.query<{
    impressions: string;
    clicks: string;
    ad_count: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE e.event_type = 'impression')::text AS impressions,
       COUNT(*) FILTER (WHERE e.event_type = 'click')::text       AS clicks,
       COUNT(DISTINCT a.id)::text                                  AS ad_count
     FROM ads a
     LEFT JOIN ad_events e ON e.ad_id = a.id ${tsCondition}
     WHERE a.sponsor_id = $1
       AND a.kind <> 'placeholder'`,
    [sponsorId],
  );
  const row = res.rows[0];
  const impressions = Number(row?.impressions ?? '0');
  const clicks = Number(row?.clicks ?? '0');
  const adCount = Number(row?.ad_count ?? '0');
  const ctr = impressions > 0 ? clicks / impressions : 0;
  return { impressions, clicks, ctr, adCount };
}
