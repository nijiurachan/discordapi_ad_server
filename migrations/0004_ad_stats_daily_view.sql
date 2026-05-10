CREATE OR REPLACE VIEW "ad_stats_daily" AS
  SELECT ad_id,
         date_trunc('day', ts) AS day,
         COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
         COUNT(*) FILTER (WHERE event_type = 'click')      AS clicks
    FROM ad_events
   GROUP BY ad_id, date_trunc('day', ts);
