-- Per-sponsor private "Ad Portal" channel (Phase 2). Modeled on
-- dm_fallback_channels. The dashboard (plan / remaining weight / cap+used /
-- active banners) is rendered into `dashboard_message_id`; `last_active_at`
-- drives the hourly idle sweep; `archived_at` soft-closes a row.
CREATE TABLE IF NOT EXISTS `portal_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`sponsor_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`dashboard_message_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_active_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsors`(`discord_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portal_channels_channel_id_unique` ON `portal_channels` (`channel_id`);--> statement-breakpoint
-- One active portal per sponsor. Partial unique index defends the INSERT-first
-- double-click race in openOrReusePortalChannel.
CREATE UNIQUE INDEX `portal_active_sponsor_idx` ON `portal_channels` (`sponsor_id`) WHERE "portal_channels"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `portal_idle_idx` ON `portal_channels` (`last_active_at`) WHERE "portal_channels"."archived_at" IS NULL;
