import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// D1/SQLite conventions used throughout:
// - UUIDs: `text` (no AUTO_RANDOM). Generated in app code via `crypto.randomUUID()`
//   and passed explicitly in every INSERT (no schema-level default).
// - Timestamps: `integer` storing epoch milliseconds. Auto-now columns use
//   `default(sql\`(unixepoch() * 1000)\`)` so raw SQL INSERTs that omit them
//   still get a value.
// - Booleans: `integer` (0/1).
// - JSON arrays / objects (previously `jsonb` or `text[]` in Postgres): `text`
//   storing a JSON string. Read/write sites JSON.parse/stringify explicitly.
//   We do not use Drizzle's `{ mode: 'json' }` because all queries are raw SQL.

const NOW_MS = sql`(unixepoch('subsec') * 1000)`;

export const tiers = sqliteTable(
  'tiers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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

export const sponsors = sqliteTable('sponsors', {
  discordUserId: text('discord_user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  currentTierId: integer('current_tier_id').references(() => tiers.id),
  updatedAt: integer('updated_at').notNull().default(NOW_MS),
});

export const ads = sqliteTable(
  'ads',
  {
    id: text('id').primaryKey(),
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
    weightAlloc: integer('weight_alloc'),
    rejectReason: text('reject_reason'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: integer('reviewed_at'),
    startsAt: integer('starts_at'),
    endsAt: integer('ends_at'),
    reviewMessageId: text('review_message_id'),
    createdByAdmin: text('created_by_admin'),
    dmDeliveryStatus: text('dm_delivery_status'),
    dmDeliveredAt: integer('dm_delivered_at'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
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
    weightAllocPositive: check(
      'ads_weight_alloc_positive',
      sql`${t.weightAlloc} IS NULL OR ${t.weightAlloc} > 0`,
    ),
    weightSnapshotPositive: check(
      'ads_weight_snapshot_positive',
      sql`${t.weightSnapshot} IS NULL OR ${t.weightSnapshot} > 0`,
    ),
    // Partial index: only the approved rows pay the index-maintenance cost.
    activeIdx: index('ads_active_idx')
      .on(t.status, t.kind, t.slot, t.startsAt, t.endsAt)
      .where(sql`${t.status} = 'approved'`),
  }),
);

export const adFormatRules = sqliteTable('ad_format_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slot: text('slot').notNull().unique(),
  // JSON arrays stored as text. Queries JSON.parse/stringify at the boundary.
  allowedMimes: text('allowed_mimes').notNull(),
  allowedExtensions: text('allowed_extensions').notNull(),
  maxBytes: integer('max_bytes').notNull(),
  minWidth: integer('min_width'),
  maxWidth: integer('max_width'),
  minHeight: integer('min_height'),
  maxHeight: integer('max_height'),
  aspectRatios: text('aspect_ratios'),
  aspectTolerance: real('aspect_tolerance').default(0.02),
  titleMaxLen: integer('title_max_len').notNull().default(80),
  bodyMaxLen: integer('body_max_len').notNull().default(500),
  linkUrlMaxLen: integer('link_url_max_len').notNull().default(2048),
  linkScheme: text('link_scheme').notNull().default(sql`'["https"]'`),
  linkDomainAllowlist: text('link_domain_allowlist'),
  linkDomainBlocklist: text('link_domain_blocklist'),
  updatedAt: integer('updated_at').notNull().default(NOW_MS),
  updatedBy: text('updated_by'),
});

export const adDrafts = sqliteTable('ad_drafts', {
  id: text('id').primaryKey(),
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
  autoApprove: integer('auto_approve'),
  endsInDays: integer('ends_in_days'),
  createdByAdmin: text('created_by_admin'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull().default(NOW_MS),
});

export const adEvents = sqliteTable(
  'ad_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // NO ACTION (not cascade) is intentional: ad_events is the impression/click
    // audit trail and must survive ads being soft-deleted (status='expired' /
    // 'withdrawn'). Hard-deleting an ad row should fail loudly here rather
    // than silently destroy historical traffic data.
    adId: text('ad_id')
      .notNull()
      .references(() => ads.id, { onDelete: 'no action' }),
    eventType: text('event_type').notNull(),
    ts: integer('ts').notNull().default(NOW_MS),
    ipHash: text('ip_hash'),
    ua: text('ua'),
    slot: text('slot'),
  },
  (t) => ({
    typeCheck: check('ad_events_type_check', sql`${t.eventType} IN ('impression','click')`),
    adIdTsIdx: index('ad_events_ad_id_ts_idx').on(t.adId, t.ts),
    // SQLite only has btree, so the BRIN replacement is a plain btree on ts.
    tsIdx: index('ad_events_ts_idx').on(t.ts),
    dedupIdx: index('idx_ad_events_dedup').on(t.adId, t.ipHash, t.eventType, t.ts),
  }),
);

export const reviewLogs = sqliteTable(
  'review_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // NO ACTION (not cascade) is intentional: review_logs is the moderator
    // audit trail (approve/reject/withdraw decisions) and must outlive any
    // hard-delete of the parent ad. Same rationale as ad_events above.
    adId: text('ad_id')
      .notNull()
      .references(() => ads.id, { onDelete: 'no action' }),
    reviewerId: text('reviewer_id').notNull(),
    action: text('action').notNull(),
    reason: text('reason'),
    ts: integer('ts').notNull().default(NOW_MS),
  },
  (t) => ({
    actionCheck: check(
      'review_logs_action_check',
      sql`${t.action} IN ('approved','rejected','withdrawn')`,
    ),
  }),
);

export const adminLogs = sqliteTable('admin_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id'),
  before: text('before'),
  after: text('after'),
  ts: integer('ts').notNull().default(NOW_MS),
});

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(NOW_MS),
  updatedBy: text('updated_by'),
});

export const dmFallbackChannels = sqliteTable(
  'dm_fallback_channels',
  {
    id: text('id').primaryKey(),
    adId: text('ad_id')
      .notNull()
      .references(() => ads.id),
    sponsorId: text('sponsor_id')
      .notNull()
      .references(() => sponsors.discordUserId, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().unique(),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    expiresAt: integer('expires_at').notNull(),
    acknowledgedAt: integer('acknowledged_at'),
  },
  (t) => ({
    pendingIdx: index('dm_fallback_pending_idx')
      .on(t.expiresAt)
      .where(sql`${t.acknowledgedAt} IS NULL`),
  }),
);

export const portalChannels = sqliteTable(
  'portal_channels',
  {
    id: text('id').primaryKey(),
    sponsorId: text('sponsor_id')
      .notNull()
      .references(() => sponsors.discordUserId, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().unique(),
    dashboardMessageId: text('dashboard_message_id'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    lastActiveAt: integer('last_active_at').notNull().default(NOW_MS),
    archivedAt: integer('archived_at'),
  },
  (t) => ({
    // One active portal per sponsor; the partial unique index makes the
    // INSERT-first double-click race fail loudly instead of double-creating.
    activeSponsorIdx: uniqueIndex('portal_active_sponsor_idx')
      .on(t.sponsorId)
      .where(sql`${t.archivedAt} IS NULL`),
    idleIdx: index('portal_idle_idx').on(t.lastActiveAt).where(sql`${t.archivedAt} IS NULL`),
  }),
);

/**
 * Per-(slot, day) shuffled "deck" of approved regular ads, used to deliver the
 * weight ratio deterministically within a 24h window. `bag` is a JSON array of
 * ad_ids where each ad appears `weight_snapshot` times; the array order is a
 * deterministic Fisher-Yates shuffle seeded by `${slot}-${day}`. `cursor`
 * advances atomically per /serve call; `signature` is a hash of the current
 * (id, weight) set used to detect mid-day ad changes — when it differs, the
 * bag is rebuilt and cursor reset.
 */
export const serveRotation = sqliteTable(
  'serve_rotation',
  {
    slot: text('slot').notNull(),
    day: text('day').notNull(),
    bag: text('bag').notNull(),
    cursor: integer('cursor').notNull().default(0),
    signature: text('signature').notNull(),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.slot, t.day] }),
  }),
);

/**
 * Daily-bucketed impression/click counts. Hand-managed view (drizzle does not
 * auto-create with `.existing()`). The body uses strftime() because `ts` is
 * stored as epoch milliseconds; `ts/1000` converts to seconds, `'unixepoch'`
 * interprets the integer as Unix time, then format as 'YYYY-MM-DD' UTC day.
 *
 * Use for whole-day reports (admin dashboards). Sponsor-facing rolling windows
 * (`24h` / `7d` / `30d`) deliberately query `ad_events` directly — see the
 * comment on `getAggregateStats` in src/db/queries/ads.ts for why day-bucketing
 * would lose intra-day boundary events.
 */
export const adStatsDaily = sqliteView('ad_stats_daily', {
  adId: text('ad_id').notNull(),
  day: text('day').notNull(),
  impressions: integer('impressions').notNull(),
  clicks: integer('clicks').notNull(),
}).existing();
