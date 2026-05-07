import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const tiers = pgTable('tiers', {
  id: serial('id').primaryKey(),
  discordRoleId: text('discord_role_id').notNull().unique(),
  name: text('name').notNull(),
  weight: integer('weight').notNull(),
  maxActiveAds: integer('max_active_ads').notNull().default(1),
  rank: integer('rank').notNull(),
}, (t) => ({
  weightCheck: check('tiers_weight_positive', sql`${t.weight} > 0`),
}));

export const sponsors = pgTable('sponsors', {
  discordUserId: text('discord_user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  currentTierId: integer('current_tier_id').references(() => tiers.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ads = pgTable('ads', {
  id: uuid('id').primaryKey().defaultRandom(),
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
  createdByAdmin: text('created_by_admin'),
  dmDeliveryStatus: text('dm_delivery_status'),
  dmDeliveredAt: timestamp('dm_delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindCheck: check(
    'ads_kind_check',
    sql`${t.kind} IN ('regular','house','placeholder')`,
  ),
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
  activeIdx: index('ads_active_idx')
    .on(t.status, t.kind, t.slot, t.startsAt, t.endsAt)
    .where(sql`${t.status} = 'approved'`),
}));

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
  sponsorId: text('sponsor_id').notNull(),
  slot: text('slot').notNull(),
  imageKey: text('image_key').notNull(),
  imageMime: text('image_mime').notNull(),
  imageBytes: integer('image_bytes').notNull(),
  imageWidth: integer('image_width'),
  imageHeight: integer('image_height'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adEvents = pgTable('ad_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  adId: uuid('ad_id').notNull().references(() => ads.id),
  eventType: text('event_type').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  ipHash: text('ip_hash'),
  ua: text('ua'),
  slot: text('slot'),
}, (t) => ({
  typeCheck: check('ad_events_type_check', sql`${t.eventType} IN ('impression','click')`),
}));

export const reviewLogs = pgTable('review_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  adId: uuid('ad_id').notNull().references(() => ads.id),
  reviewerId: text('reviewer_id').notNull(),
  action: text('action').notNull(),
  reason: text('reason'),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  actionCheck: check(
    'review_logs_action_check',
    sql`${t.action} IN ('approved','rejected','withdrawn')`,
  ),
}));

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

export const dmFallbackChannels = pgTable('dm_fallback_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  adId: uuid('ad_id').notNull().references(() => ads.id),
  sponsorId: text('sponsor_id').notNull(),
  channelId: text('channel_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
}, (t) => ({
  pendingIdx: index('dm_fallback_pending_idx')
    .on(t.expiresAt)
    .where(sql`${t.acknowledgedAt} IS NULL`),
}));
