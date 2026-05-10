import type { PgClient } from '../client.ts';

export type StatsPeriod = '24h' | '7d' | '30d' | '90d' | 'all';

const PERIOD_INTERVAL: Record<StatsPeriod, string | null> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
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
  const interval = PERIOD_INTERVAL[period];
  const tsCondition = interval ? `AND e.ts >= now() - interval '${interval}'` : '';
  const res = await client.query<{
    ad_id: string;
    sponsor_id: string | null;
    kind: string;
    slot: string;
    title: string;
    impressions: string;
    clicks: string;
  }>(
    `SELECT a.id::text AS ad_id,
            a.sponsor_id,
            a.kind,
            a.slot,
            a.title,
            COUNT(*) FILTER (WHERE e.event_type = 'impression')::text AS impressions,
            COUNT(*) FILTER (WHERE e.event_type = 'click')::text       AS clicks
       FROM ads a
       LEFT JOIN ad_events e ON e.ad_id = a.id ${tsCondition}
      WHERE a.kind <> 'placeholder'
      GROUP BY a.id, a.sponsor_id, a.kind, a.slot, a.title
      ORDER BY COUNT(*) FILTER (WHERE e.event_type = 'impression') DESC NULLS LAST,
               COUNT(*) FILTER (WHERE e.event_type = 'click') DESC NULLS LAST
      LIMIT $1`,
    [limit],
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
