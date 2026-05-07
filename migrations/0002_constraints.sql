DROP INDEX IF EXISTS "ad_events_ad_ts_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_drafts" ADD CONSTRAINT "ad_drafts_sponsor_id_sponsors_discord_user_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("discord_user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_fallback_channels" ADD CONSTRAINT "dm_fallback_channels_sponsor_id_sponsors_discord_user_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("discord_user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_events_ad_id_ts_idx" ON "ad_events" USING btree ("ad_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_events_ts_idx" ON "ad_events" USING brin ("ts");--> statement-breakpoint
ALTER TABLE "tiers" ADD CONSTRAINT "tiers_rank_unique" UNIQUE("rank");--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_period_check" CHECK ("ads"."starts_at" IS NULL OR "ads"."ends_at" IS NULL OR "ads"."starts_at" <= "ads"."ends_at");--> statement-breakpoint
ALTER TABLE "tiers" ADD CONSTRAINT "tiers_max_active_ads_positive" CHECK ("tiers"."max_active_ads" > 0);