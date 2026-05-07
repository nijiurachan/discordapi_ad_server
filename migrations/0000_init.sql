CREATE TABLE IF NOT EXISTS "ad_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sponsor_id" text NOT NULL,
	"slot" text NOT NULL,
	"image_key" text NOT NULL,
	"image_mime" text NOT NULL,
	"image_bytes" integer NOT NULL,
	"image_width" integer,
	"image_height" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ad_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"ua" text,
	"slot" text,
	CONSTRAINT "ad_events_type_check" CHECK ("ad_events"."event_type" IN ('impression','click'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_format_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"slot" text NOT NULL,
	"allowed_mimes" text[] NOT NULL,
	"allowed_extensions" text[] NOT NULL,
	"max_bytes" integer NOT NULL,
	"min_width" integer,
	"max_width" integer,
	"min_height" integer,
	"max_height" integer,
	"aspect_ratios" text[],
	"aspect_tolerance" numeric(4, 3) DEFAULT '0.020',
	"title_max_len" integer DEFAULT 80 NOT NULL,
	"body_max_len" integer DEFAULT 500 NOT NULL,
	"link_url_max_len" integer DEFAULT 2048 NOT NULL,
	"link_scheme" text[] DEFAULT ARRAY['https']::text[] NOT NULL,
	"link_domain_allowlist" text[],
	"link_domain_blocklist" text[],
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "ad_format_rules_slot_unique" UNIQUE("slot")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sponsor_id" text,
	"kind" text DEFAULT 'regular' NOT NULL,
	"slot" text DEFAULT 'default' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_url" text NOT NULL,
	"image_key" text,
	"image_mime" text,
	"image_bytes" integer,
	"image_width" integer,
	"image_height" integer,
	"status" text NOT NULL,
	"weight_snapshot" integer,
	"reject_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by_admin" text,
	"dm_delivery_status" text,
	"dm_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_kind_check" CHECK ("ads"."kind" IN ('regular','house','placeholder')),
	CONSTRAINT "ads_status_check" CHECK ("ads"."status" IN ('pending','approved','paused','rejected','expired','withdrawn')),
	CONSTRAINT "ads_dm_status_check" CHECK ("ads"."dm_delivery_status" IS NULL OR "ads"."dm_delivery_status" IN
        ('pending','sent','failed','fallback_posted','fallback_acknowledged')),
	CONSTRAINT "ads_kind_sponsor" CHECK (("ads"."kind" = 'regular' AND "ads"."sponsor_id" IS NOT NULL)
     OR ("ads"."kind" IN ('house','placeholder') AND "ads"."sponsor_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_fallback_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_id" uuid NOT NULL,
	"sponsor_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "dm_fallback_channels_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ad_id" uuid NOT NULL,
	"reviewer_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_logs_action_check" CHECK ("review_logs"."action" IN ('approved','rejected','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sponsors" (
	"discord_user_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"current_tier_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_role_id" text NOT NULL,
	"name" text NOT NULL,
	"weight" integer NOT NULL,
	"max_active_ads" integer DEFAULT 1 NOT NULL,
	"rank" integer NOT NULL,
	CONSTRAINT "tiers_discord_role_id_unique" UNIQUE("discord_role_id"),
	CONSTRAINT "tiers_weight_positive" CHECK ("tiers"."weight" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_events" ADD CONSTRAINT "ad_events_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads" ADD CONSTRAINT "ads_sponsor_id_sponsors_discord_user_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("discord_user_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_fallback_channels" ADD CONSTRAINT "dm_fallback_channels_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_current_tier_id_tiers_id_fk" FOREIGN KEY ("current_tier_id") REFERENCES "public"."tiers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_active_idx" ON "ads" USING btree ("status","kind","slot","starts_at","ends_at") WHERE "ads"."status" = 'approved';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_fallback_pending_idx" ON "dm_fallback_channels" USING btree ("expires_at") WHERE "dm_fallback_channels"."acknowledged_at" IS NULL;