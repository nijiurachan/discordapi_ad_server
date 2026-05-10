-- Speeds up dedup query in ad-events isRecentEvent / insertEventIfNotRecent:
--   WHERE ad_id = $1 AND ip_hash = $2 AND event_type = $3 AND ts > ...
-- Drizzle-kit runs each migration in a single transaction so we cannot use
-- CREATE INDEX CONCURRENTLY here. The table is empty on first deploy; after
-- significant growth, an out-of-band CONCURRENTLY rebuild can replace this.
CREATE INDEX IF NOT EXISTS "idx_ad_events_dedup"
  ON "ad_events" ("ad_id", "ip_hash", "event_type", "ts");
