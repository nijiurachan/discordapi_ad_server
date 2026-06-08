import type { PgClient } from '../client.ts';

export type PortalRow = {
  id: string;
  sponsorId: string;
  channelId: string;
  dashboardMessageId: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  archivedAt: Date | null;
};

type PortalDbRow = {
  id: string;
  sponsor_id: string;
  channel_id: string;
  dashboard_message_id: string | null;
  created_at: Date;
  last_active_at: Date;
  archived_at: Date | null;
};

function mapRow(r: PortalDbRow): PortalRow {
  return {
    id: r.id,
    sponsorId: r.sponsor_id,
    channelId: r.channel_id,
    dashboardMessageId: r.dashboard_message_id,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    archivedAt: r.archived_at,
  };
}

export async function findOpenPortalBySponsor(
  client: PgClient,
  sponsorId: string,
): Promise<PortalRow | null> {
  const res = await client.query<PortalDbRow>(
    `SELECT id, sponsor_id, channel_id, dashboard_message_id,
            created_at, last_active_at, archived_at
       FROM portal_channels
      WHERE sponsor_id = ?
        AND archived_at IS NULL
      LIMIT 1`,
    [sponsorId],
  );
  const r = res.rows[0];
  return r ? mapRow(r) : null;
}

export async function findPortalById(client: PgClient, id: string): Promise<PortalRow | null> {
  const res = await client.query<PortalDbRow>(
    `SELECT id, sponsor_id, channel_id, dashboard_message_id,
            created_at, last_active_at, archived_at
       FROM portal_channels
      WHERE id = ?
      LIMIT 1`,
    [id],
  );
  const r = res.rows[0];
  return r ? mapRow(r) : null;
}

/**
 * Look a portal up by the Discord channel the interaction happened in. Used by
 * the owner check on portal:close so the not_owner branch is reachable (we
 * compare the stored sponsor_id to the clicker, NOT findOpenPortalBySponsor of
 * the clicker — which would only ever find the clicker's own portal).
 */
export async function findOpenPortalByChannel(
  client: PgClient,
  channelId: string,
): Promise<PortalRow | null> {
  const res = await client.query<PortalDbRow>(
    `SELECT id, sponsor_id, channel_id, dashboard_message_id,
            created_at, last_active_at, archived_at
       FROM portal_channels
      WHERE channel_id = ?
        AND archived_at IS NULL
      LIMIT 1`,
    [channelId],
  );
  const r = res.rows[0];
  return r ? mapRow(r) : null;
}

export async function createPortalRow(
  client: PgClient,
  args: { id: string; sponsorId: string; channelId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO portal_channels (id, sponsor_id, channel_id)
     VALUES (?, ?, ?)`,
    [args.id, args.sponsorId, args.channelId],
  );
}

export async function setPortalDashboardMessageId(
  client: PgClient,
  id: string,
  messageId: string,
): Promise<void> {
  await client.query('UPDATE portal_channels SET dashboard_message_id = ? WHERE id = ?', [
    messageId,
    id,
  ]);
}

export async function touchPortalActivity(client: PgClient, id: string): Promise<void> {
  await client.query(
    'UPDATE portal_channels SET last_active_at = (unixepoch() * 1000) WHERE id = ?',
    [id],
  );
}

export async function closePortalRow(client: PgClient, id: string): Promise<void> {
  await client.query(
    'UPDATE portal_channels SET archived_at = (unixepoch() * 1000) WHERE id = ? AND archived_at IS NULL',
    [id],
  );
}

export type ActiveBanner = {
  id: string;
  slot: string;
  title: string;
  status: string;
  weightAlloc: number | null;
};

/**
 * CANONICAL `getSponsorActiveBanners` — this is the ONLY definition of this
 * function in the codebase (Phase 1 must NOT define a function of this name;
 * if Phase 1 needs a banner list it uses its existing getSponsorAds).
 *
 * Dashboard read: the sponsor's approved+pending REGULAR, non-admin ads with
 * their per-banner weight allocation. Returns `{ id, slot, title, status, weightAlloc }`.
 * Distinct from getSponsorAds (LIMIT 5, includes terminal statuses).
 * `weight_alloc` is the Phase-1 column.
 *
 * The `created_by_admin IS NULL` filter mirrors sumActiveWeight in
 * src/sponsors/tier.ts: admin-contributed ads are intentionally out of the
 * sponsor's budget, so they must not be counted as used banners either. Without
 * it the dashboard 件数(使用/上限) would over-count and list an admin ad that
 * does not consume the budget (spec line 61: 'regular・非admin の pending+approved').
 */
export async function getSponsorActiveBanners(
  client: PgClient,
  sponsorId: string,
): Promise<ActiveBanner[]> {
  const res = await client.query<{
    id: string;
    slot: string;
    title: string;
    status: string;
    weight_alloc: number | null;
  }>(
    `SELECT id, slot, title, status, weight_alloc
       FROM ads
      WHERE sponsor_id = ?
        AND kind = 'regular'
        AND created_by_admin IS NULL
        AND status IN ('approved', 'pending')
      ORDER BY
        CASE status WHEN 'approved' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        created_at DESC`,
    [sponsorId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    slot: r.slot,
    title: r.title,
    status: r.status,
    weightAlloc: r.weight_alloc,
  }));
}

/**
 * Atomic, single-statement ownership + budget guarded weight change (Task 3
 * §3.C-3.2). Mirrors the conditional writes in submit-modal.ts (INSERT) and
 * review.ts:approvePendingWithinBudget (UPDATE): D1/SQLite has no row locks, so
 * the only safe budget primitive is ONE conditional statement that flips the
 * value only when it still fits.
 *
 * `weight_alloc` is set to `newWeight` ONLY when:
 *  - the row is the clicker's own (sponsor_id = clickerId — a NON-owner therefore
 *    yields changes=0, no separate ownership read needed),
 *  - it is a regular, currently-budget-holding ad (kind='regular',
 *    status IN pending/approved), and
 *  - the change does NOT increase this ad's own allocation (newWeight <= the
 *    row's CURRENT weight_alloc — a decrease/no-op is always safe), OR
 *  - Σ weight_alloc over the sponsor's OTHER pending/approved regular non-admin
 *    ads, plus `newWeight`, is still <= the live tier weight.
 *
 * The decrease/no-op short-circuit unblocks an OVER-BUDGET sponsor (e.g. from a
 * past data state where OTHER alloc alone exceeds the tier): without it the
 * budget sum-check would reject EVERY change — even a reduction — trapping them.
 *
 * `meta.changes` (rowCount) == 1 ⇒ applied. == 0 ⇒ budget exceeded OR not the
 * owner OR the ad is gone/terminal — the caller surfaces an ephemeral reason and
 * does NOT recalc/re-render. The `?`-placeholder repeated-binding style (same
 * value re-listed in params) matches submit-modal/approve.
 */
export async function updateAdWeightWithinBudget(
  client: PgClient,
  adId: string,
  clickerId: string,
  newWeight: number,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE ads
        SET weight_alloc = ?
      WHERE id = ?
        AND sponsor_id = ?
        AND kind = 'regular'
        AND created_by_admin IS NULL
        AND status IN ('pending', 'approved')
        AND (
          ? <= COALESCE(weight_alloc, 0)
          OR (
            (SELECT COALESCE(SUM(weight_alloc), 0)
               FROM ads
              WHERE sponsor_id = ?
                AND kind = 'regular'
                AND created_by_admin IS NULL
                AND status IN ('pending', 'approved')
                AND id != ?) + ?
          ) <= (SELECT t.weight
                  FROM tiers t
                  JOIN sponsors s ON s.current_tier_id = t.id
                 WHERE s.discord_user_id = ?)
        )`,
    [newWeight, adId, clickerId, newWeight, clickerId, adId, newWeight, clickerId],
  );
  return (res.rowCount ?? 0) === 1;
}
