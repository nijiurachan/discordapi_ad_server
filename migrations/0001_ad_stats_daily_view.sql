-- ad_stats_daily: daily-bucketed impression/click counts.
-- `ts` is epoch milliseconds, so `ts/1000` converts to seconds and
-- `strftime(..., 'unixepoch')` formats as a YYYY-MM-DD UTC day string.
-- Used for whole-day reports (admin dashboards). Rolling sponsor windows
-- query `ad_events` directly to preserve intra-day precision.
CREATE VIEW IF NOT EXISTS ad_stats_daily AS
SELECT
  ad_id,
  strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
  COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
  COUNT(*) FILTER (WHERE event_type = 'click')      AS clicks
FROM ad_events
GROUP BY ad_id, strftime('%Y-%m-%d', ts / 1000, 'unixepoch');
