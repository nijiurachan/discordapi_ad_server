CREATE TABLE `ad_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`sponsor_id` text,
	`slot` text NOT NULL,
	`image_key` text NOT NULL,
	`image_mime` text NOT NULL,
	`image_bytes` integer NOT NULL,
	`image_width` integer,
	`image_height` integer,
	`kind` text,
	`weight` integer,
	`auto_approve` integer,
	`ends_in_days` integer,
	`created_by_admin` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsors`(`discord_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ad_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ad_id` text NOT NULL,
	`event_type` text NOT NULL,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`ip_hash` text,
	`ua` text,
	`slot` text,
	FOREIGN KEY (`ad_id`) REFERENCES `ads`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ad_events_type_check" CHECK("ad_events"."event_type" IN ('impression','click'))
);
--> statement-breakpoint
CREATE INDEX `ad_events_ad_id_ts_idx` ON `ad_events` (`ad_id`,`ts`);--> statement-breakpoint
CREATE INDEX `ad_events_ts_idx` ON `ad_events` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_ad_events_dedup` ON `ad_events` (`ad_id`,`ip_hash`,`event_type`,`ts`);--> statement-breakpoint
CREATE TABLE `ad_format_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slot` text NOT NULL,
	`allowed_mimes` text NOT NULL,
	`allowed_extensions` text NOT NULL,
	`max_bytes` integer NOT NULL,
	`min_width` integer,
	`max_width` integer,
	`min_height` integer,
	`max_height` integer,
	`aspect_ratios` text,
	`aspect_tolerance` real DEFAULT 0.02,
	`title_max_len` integer DEFAULT 80 NOT NULL,
	`body_max_len` integer DEFAULT 500 NOT NULL,
	`link_url_max_len` integer DEFAULT 2048 NOT NULL,
	`link_scheme` text DEFAULT '["https"]' NOT NULL,
	`link_domain_allowlist` text,
	`link_domain_blocklist` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_format_rules_slot_unique` ON `ad_format_rules` (`slot`);--> statement-breakpoint
CREATE TABLE `admin_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text,
	`before` text,
	`after` text,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ads` (
	`id` text PRIMARY KEY NOT NULL,
	`sponsor_id` text,
	`kind` text DEFAULT 'regular' NOT NULL,
	`slot` text DEFAULT 'default' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link_url` text NOT NULL,
	`image_key` text,
	`image_mime` text,
	`image_bytes` integer,
	`image_width` integer,
	`image_height` integer,
	`status` text NOT NULL,
	`weight_snapshot` integer,
	`reject_reason` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`starts_at` integer,
	`ends_at` integer,
	`review_message_id` text,
	`created_by_admin` text,
	`dm_delivery_status` text,
	`dm_delivered_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsors`(`discord_user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ads_kind_check" CHECK("ads"."kind" IN ('regular','house','placeholder')),
	CONSTRAINT "ads_status_check" CHECK("ads"."status" IN ('pending','approved','paused','rejected','expired','withdrawn')),
	CONSTRAINT "ads_dm_status_check" CHECK("ads"."dm_delivery_status" IS NULL OR "ads"."dm_delivery_status" IN
        ('pending','sent','failed','fallback_posted','fallback_acknowledged')),
	CONSTRAINT "ads_kind_sponsor" CHECK(("ads"."kind" = 'regular' AND "ads"."sponsor_id" IS NOT NULL)
     OR ("ads"."kind" IN ('house','placeholder') AND "ads"."sponsor_id" IS NULL)),
	CONSTRAINT "ads_period_check" CHECK("ads"."starts_at" IS NULL OR "ads"."ends_at" IS NULL OR "ads"."starts_at" <= "ads"."ends_at")
);
--> statement-breakpoint
CREATE INDEX `ads_active_idx` ON `ads` (`status`,`kind`,`slot`,`starts_at`,`ends_at`) WHERE "ads"."status" = 'approved';--> statement-breakpoint
CREATE TABLE `dm_fallback_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`ad_id` text NOT NULL,
	`sponsor_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`acknowledged_at` integer,
	FOREIGN KEY (`ad_id`) REFERENCES `ads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsors`(`discord_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dm_fallback_channels_channel_id_unique` ON `dm_fallback_channels` (`channel_id`);--> statement-breakpoint
CREATE INDEX `dm_fallback_pending_idx` ON `dm_fallback_channels` (`expires_at`) WHERE "dm_fallback_channels"."acknowledged_at" IS NULL;--> statement-breakpoint
CREATE TABLE `review_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ad_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`ad_id`) REFERENCES `ads`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_logs_action_check" CHECK("review_logs"."action" IN ('approved','rejected','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE `sponsors` (
	`discord_user_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`current_tier_id` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`current_tier_id`) REFERENCES `tiers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `tiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`discord_role_id` text NOT NULL,
	`name` text NOT NULL,
	`weight` integer NOT NULL,
	`max_active_ads` integer DEFAULT 1 NOT NULL,
	`rank` integer NOT NULL,
	CONSTRAINT "tiers_weight_positive" CHECK("tiers"."weight" > 0),
	CONSTRAINT "tiers_max_active_ads_positive" CHECK("tiers"."max_active_ads" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tiers_discord_role_id_unique` ON `tiers` (`discord_role_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tiers_rank_unique` ON `tiers` (`rank`);