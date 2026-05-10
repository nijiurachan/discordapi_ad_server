import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const tiers = pgTable(
  'tiers',
  {
    id: serial('id').primaryKey(),
    discordRoleId: text('discord_role_id').notNull().unique(),
    name: text('name').notNull(),
    weight: integer('weight').notNull(),
    maxActiveAds: integer('max_active_ads').notNull().default(1),
    rank: integer('rank').notNull(),
  },
  (t) => ({
    weightCheck: check('tiers_weight_positive', sql`${t.weight} > 0`),
    maxActivePositive: check('tiers_max_active_ads_positive', sql`${t.maxActiveAds} > 0`),
    rankUnique: unique('tiers_rank_unique').on(t.rank),
  }),
);

export const sponsors = pgTable('sponsors', {
  discordUserId: text('discord_user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  currentTierId: integer('current_tier_id').references(() => tiers.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ads = pgTable(
  'ads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // No onDelete cascade: ads must outlive sponsor deletion for audit/history
    // (status transitions to 'expired'/'withdrawn' instead of hard delete).
    sponsorId: text('sponsor_id').references(() => sponsors.discordUserId),
    kind: text('kind').notNull().default('regular'),
    slot: text('slot').notNull().default('default'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    linkUrl: text('link_url').notNull(),
    imageKey: text('image_key'),
    imageMime: text('image_mime'),
    imageBytes: integer('image_bytes'),
    imageWidth: integer('image_width'),
    imageHeight: integer('image_height'),
    status: text('status').notNull(),
    weightSnapshot: integer('weight_snapshot'),
    rejectReason: text('reject_reason'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    reviewMessageId: text('review_message_id'),
    createdByAdmin: text('created_by_admin'),
    dmDeliveryStatus: text('dm_delivery_status'),
    dmDeliveredAt: timestamp('dm_delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check('ads_kind_check', sql`${t.kind} IN ('regular','house','placeholder')`),
    statusCheck: check(
      'ads_status_check',
      sql`${t.status} IN ('pending','approved','paused','rejected','expired','withdrawn')`,
    ),
    dmStatusCheck: check(
      'ads_dm_status_check',
      sql`${t.dmDeliveryStatus} IS NULL OR ${t.dmDeliveryStatus} IN
        ('pending','sent','failed','fallback_posted','fallback_acknowledged')`,
    ),
    kindSponsorCheck: check(
      'ads_kind_sponsor',
      sql`(${t.kind} = 'regular' AND ${t.sponsorId} IS NOT NULL)
     OR (${t.kind} IN ('house','placeholder') AND ${t.sponsorId} IS NULL)`,
    ),
    periodCheck: check(
      'ads_period_check',
      sql`${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.startsAt} <= ${t.endsAt}`,
    ),
    activeIdx: index('ads_active_idx')
      .on(t.status, t.kind, t.slot, t.startsAt, t.endsAt)
      .where(sql`${t.status} = 'approved'`),
  }),
);

export const adFormatRules = pgTable('ad_format_rules', {
  id: serial('id').primaryKey(),
  slot: text('slot').notNull().unique(),
  allowedMimes: text('allowed_mimes').array().notNull(),
  allowedExtensions: text('allowed_extensions').array().notNull(),
  maxBytes: integer('max_bytes').notNull(),
  minWidth: integer('min_width'),
  maxWidth: integer('max_width'),
  minHeight: integer('min_height'),
  maxHeight: integer('max_height'),
  aspectRatios: text('aspect_ratios').array(),
  aspectTolerance: numeric('aspect_tolerance', { precision: 4, scale: 3 }).default('0.020'),
  titleMaxLen: integer('title_max_len').notNull().default(80),
  bodyMaxLen: integer('body_max_len').notNull().default(500),
  linkUrlMaxLen: integer('link_url_max_len').notNull().default(2048),
  linkScheme: text('link_scheme').array().notNull().default(sql`ARRAY['https']::text[]`),
  linkDomainAllowlist: text('link_domain_allowlist').array(),
  linkDomainBlocklist: text('link_domain_blocklist').array(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export const adDrafts = pgTable('ad_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Nullable for admin-submitted house/placeholder drafts that have no sponsor.
  sponsorId: text('sponsor_id').references(() => sponsors.discordUserId, { onDelete: 'cascade' }),
  slot: text('slot').notNull(),
  imageKey: text('image_key').notNull(),
  imageMime: text('image_mime').notNull(),
  imageBytes: integer('image_bytes').notNull(),
  imageWidth: integer('image_width'),
  imageHeight: integer('image_height'),
  // Admin-submit extras (NULL for sponsor-submitted drafts).
  kind: text('kind'),
  weight: integer('weight'),
  autoApprove: boolean('auto_approve'),
  endsInDays: integer('ends_in_days'),
  createdByAdmin: text('created_by_admin'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adEvents = pgTable(
  'ad_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    // NO ACTION (not cascade) is intentional: ad_events is the impression/click
    // audit trail and must survive ads being soft-deleted (status='expired' /
    // 'withdrawn'). Hard-deleting an ad row should fail loudly here rather
    // than silently destroy historical traffic data.
    adId: uuid('ad_id')
      .notNull()
      .references(() => ads.id, { onDelete: 'no action' }),
    eventType: text('event_type').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    ipHash: text('ip_hash'),
    ua: text('ua'),
    slot: text('slot'),
  },
  (t) => ({
    typeCheck: check('ad_events_type_check', sql`${t.eventType} IN ('impression','click')`),
    adIdTsIdx: index('ad_events_ad_id_ts_idx').using('btree', t.adId, t.ts),
    tsIdx: index('ad_events_ts_idx').using('brin', t.ts),
    dedupIdx: index('idx_ad_events_dedup').using('btree', t.adId, t.ipHash, t.eventType, t.ts),
  }),
);

export const reviewLogs = pgTable(
  'review_logs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    // NO ACTION (not cascade) is intentional: review_logs is the moderator
    // audit trail (approve/reject/withdraw decisions) and must outlive any
    // hard-delete of the parent ad. The same rationale as ad_events above.
    adId: uuid('ad_id')
      .notNull()
      .references(() => ads.id, { onDelete: 'no action' }),
    reviewerId: text('reviewer_id').notNull(),
    action: text('action').notNull(),
    reason: text('reason'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actionCheck: check(
      'review_logs_action_check',
      sql`${t.action} IN ('approved','rejected','withdrawn')`,
    ),
  }),
);

export const adminLogs = pgTable('admin_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export const dmFallbackChannels = pgTable(
  'dm_fallback_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adId: uuid('ad_id')
      .notNull()
      .references(() => ads.id),
    sponsorId: text('sponsor_id')
      .notNull()
      .references(() => sponsors.discordUserId, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (t) => ({
    pendingIdx: index('dm_fallback_pending_idx')
      .on(t.expiresAt)
      .where(sql`${t.acknowledgedAt} IS NULL`),
  }),
);

/**
 * Daily-bucketed impression/click counts. Hand-managed by
 * migrations/0004_ad_stats_daily_view.sql; declared `.existing()` so
 * drizzle-kit doesn't try to redefine it.
 *
 * Use for whole-day reports (admin dashboards). Sponsor-facing rolling
 * windows (`24h` / `7d` / `30d`) deliberately query `ad_events` directly
 * — see the comment on `getAggregateStats` in src/db/queries/ads.ts for
 * why bucketing to days would lose intra-day boundary events.
 */
export const adStatsDaily = pgView('ad_stats_daily', {
  adId: uuid('ad_id').notNull(),
  day: timestamp('day', { withTimezone: true }).notNull(),
  impressions: bigint('impressions', { mode: 'bigint' }).notNull(),
  clicks: bigint('clicks', { mode: 'bigint' }).notNull(),
}).existing();
