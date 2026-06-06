import type { PgClient } from '../client.ts';

export type StatsPeriod = '24h' | '7d' | '30d' | '90d' | 'all';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PERIOD_MS: Record<StatsPeriod, number | null> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
  all: null,
};

export type AdminStatsRow = {
  adId: string;
  sponsorId: string | null;
  kind: string;
  slot: string;
  title: string;
  impressions: number;
  clicks: number;
  ctr: number;
};

export async function getTopAdsStats(
  client: PgClient,
  period: StatsPeriod,
  limit: number,
): Promise<AdminStatsRow[]> {
  const windowMs = PERIOD_MS[period];
  const tsCondition = windowMs !== null ? 'AND e.ts >= ?' : '';
  const params: unknown[] = windowMs !== null ? [Date.now() - windowMs, limit] : [limit];
  const res = await client.query<{
    ad_id: string;
    sponsor_id: string | null;
    kind: string;
    slot: string;
    title: string;
    impressions: string;
    clicks: string;
  }>(
    `SELECT a.id AS ad_id,
            a.sponsor_id,
            a.kind,
            a.slot,
            a.title,
            COUNT(*) FILTER (WHERE e.event_type = 'impression') AS impressions,
            COUNT(*) FILTER (WHERE e.event_type = 'click')       AS clicks
       FROM ads a
       LEFT JOIN ad_events e ON e.ad_id = a.id ${tsCondition}
      WHERE a.kind <> 'placeholder'
      GROUP BY a.id, a.sponsor_id, a.kind, a.slot, a.title
      ORDER BY COUNT(*) FILTER (WHERE e.event_type = 'impression') DESC,
               COUNT(*) FILTER (WHERE e.event_type = 'click') DESC
      LIMIT ?`,
    params,
  );
  return res.rows.map((r) => {
    const impressions = Number(r.impressions);
    const clicks = Number(r.clicks);
    return {
      adId: r.ad_id,
      sponsorId: r.sponsor_id,
      kind: r.kind,
      slot: r.slot,
      title: r.title,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
    };
  });
}
