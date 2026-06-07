import type { PgClient } from '../db/client.ts';
import { type DiscordRest, DiscordRestError } from '../discord/rest.ts';

export type AuditResult = {
  sponsorsChecked: number;
  sponsorsLeft: number;
  sponsorsLostTier: number;
  sponsorsWeightSynced: number;
  adsWithdrawn: number;
  adsWeightChanged: number;
  errors: number;
};

const DISCORD_ERR_UNKNOWN_MEMBER = 10007;

type TierRow = { id: number; discord_role_id: string; weight: number; rank: number };

type ProbedMember =
  | { kind: 'left' }
  | { kind: 'present'; roles: string[] }
  | { kind: 'error' };

async function probeMember(
  rest: DiscordRest,
  guildId: string,
  userId: string,
): Promise<ProbedMember> {
  try {
    const m = await rest.getGuildMember(guildId, userId);
    return { kind: 'present', roles: m.roles ?? [] };
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 404) {
      // Only treat Discord's explicit "Unknown Member" (10007) as "left".
      // Bare 404 without that code could mean unknown guild / transient
      // routing issue — fall through to 'error' so we retry next run.
      try {
        const body = JSON.parse(err.bodyText);
        if (body?.code === DISCORD_ERR_UNKNOWN_MEMBER) return { kind: 'left' };
      } catch {
        /* malformed body — be conservative */
      }
    }
    return { kind: 'error' };
  }
}

function pickCurrentTier(tiers: TierRow[], memberRoles: string[]): TierRow | null {
  if (memberRoles.length === 0) return null;
  const have = new Set(memberRoles);
  // tiers comes pre-sorted rank DESC (most prestigious first), so the first
  // match wins — same precedence as refreshSponsorTier in src/sponsors/tier.ts.
  return tiers.find((t) => have.has(t.discord_role_id)) ?? null;
}

async function withdrawAllForSponsor(
  client: PgClient,
  sponsorId: string,
  reason: string,
  action: string,
): Promise<string[]> {
  // Match the exclusion in the outer iteration: admin-contributed ads never
  // get auto-withdrawn here even if some future query path lets them in.
  const res = await client.query<{ id: string }>(
    `UPDATE ads
        SET status = 'withdrawn',
            ends_at = (unixepoch() * 1000)
      WHERE sponsor_id = ?
        AND created_by_admin IS NULL
        AND status IN ('approved', 'pending', 'paused')
     RETURNING id`,
    [sponsorId],
  );
  for (const { id } of res.rows) {
    await client.query(
      `INSERT INTO review_logs (ad_id, reviewer_id, action, reason)
         VALUES (?, 'system', 'withdrawn', ?)`,
      [id, reason],
    );
  }
  if (res.rows.length > 0) {
    await client.query(
      `INSERT INTO admin_logs (actor_id, action, target_kind, target_id, after)
         VALUES ('system', ?, 'sponsor', ?, ?)`,
      [action, sponsorId, JSON.stringify({ ad_ids: res.rows.map((r) => r.id) })],
    );
  }
  return res.rows.map((r) => r.id);
}

async function syncWeightForSponsor(
  client: PgClient,
  sponsorId: string,
  newWeight: number,
): Promise<{ id: string; oldWeight: number | null }[]> {
  // Only re-snapshot already-approved (currently-serving) ads. pending ads will
  // pick up the live tier weight at approval time via approveAd; paused ads
  // are held intentionally and shouldn't be touched.
  // Admin-contributed ads carry an admin-set weight (often manually tuned);
  // don't clobber it from the sponsor's live tier on every cron run.
  const changed = await client.query<{ id: string; weight_snapshot: number | null }>(
    `SELECT id, weight_snapshot
       FROM ads
      WHERE sponsor_id = ?
        AND created_by_admin IS NULL
        AND status = 'approved'
        AND (weight_snapshot IS NULL OR weight_snapshot != ?)`,
    [sponsorId, newWeight],
  );
  if (changed.rows.length === 0) return [];
  await client.query(
    `UPDATE ads
        SET weight_snapshot = ?
      WHERE sponsor_id = ?
        AND created_by_admin IS NULL
        AND status = 'approved'
        AND (weight_snapshot IS NULL OR weight_snapshot != ?)`,
    [newWeight, sponsorId, newWeight],
  );
  await client.query(
    `INSERT INTO admin_logs (actor_id, action, target_kind, target_id, after)
       VALUES ('system', 'auto_resnapshot_weight', 'sponsor', ?, ?)`,
    [
      sponsorId,
      JSON.stringify({
        new_weight: newWeight,
        affected: changed.rows.map((r) => ({ id: r.id, old_weight: r.weight_snapshot })),
      }),
    ],
  );
  return changed.rows.map((r) => ({ id: r.id, oldWeight: r.weight_snapshot }));
}

/**
 * Daily reconciliation between Discord membership/role state and the ad DB.
 *
 * For every sponsor with a still-serving ad (approved / pending / paused):
 *   1. Probe Discord for their guild membership (single REST call per sponsor).
 *   2. Left the guild   -> withdraw every still-active ad ("plan cancelled").
 *   3. Still a member, but no tier role at all -> withdraw too (same intent —
 *      they kept their account but dropped supporter status).
 *   4. Still a member with a tier role -> re-snapshot weight_snapshot on each
 *      approved ad so a tier change (up or down) is reflected the next day.
 *
 * Conservative on transient errors (bot kicked, Discord 5xx, malformed bodies)
 * — those sponsors are counted under `errors` and retried next run rather
 * than wiping inventory or shifting weight on partial data.
 *
 * No DM is sent: the user is either gone (DM would fail) or in a sensitive
 * state (drop-out, downgrade) where a bot message would be tone-deaf. Admins
 * can audit through admin_logs (`auto_withdraw_on_leave`,
 * `auto_withdraw_on_lost_tier`, `auto_resnapshot_weight`).
 */
export async function auditSponsorMembership(
  client: PgClient,
  rest: DiscordRest,
  guildId: string,
): Promise<AuditResult> {
  // Exclude admin-contributed ads (created_by_admin IS NOT NULL). Those are
  // operations / house promos that share the admin's Discord ID as the
  // nominal sponsor — but the admin almost never holds a supporter tier role
  // themselves, so the "lost tier" branch would auto-withdraw them every day.
  // The membership audit only makes sense against actual paying sponsors.
  const sponsorsRes = await client.query<{ sponsor_id: string }>(
    `SELECT DISTINCT sponsor_id
       FROM ads
      WHERE sponsor_id IS NOT NULL
        AND created_by_admin IS NULL
        AND status IN ('approved', 'pending', 'paused')`,
  );

  // Pull tiers once — rank DESC matches refreshSponsorTier's "highest-rank wins"
  // semantics for sponsors who happen to hold multiple supporter roles.
  const tiersRes = await client.query<TierRow>(
    'SELECT id, discord_role_id, weight, rank FROM tiers ORDER BY rank DESC',
  );
  const tiers = tiersRes.rows;

  const result: AuditResult = {
    sponsorsChecked: 0,
    sponsorsLeft: 0,
    sponsorsLostTier: 0,
    sponsorsWeightSynced: 0,
    adsWithdrawn: 0,
    adsWeightChanged: 0,
    errors: 0,
  };

  for (const { sponsor_id: sponsorId } of sponsorsRes.rows) {
    result.sponsorsChecked++;
    const probed = await probeMember(rest, guildId, sponsorId);

    if (probed.kind === 'error') {
      result.errors++;
      continue;
    }

    if (probed.kind === 'left') {
      result.sponsorsLeft++;
      const ids = await withdrawAllForSponsor(
        client,
        sponsorId,
        'sponsor left guild (auto-withdraw)',
        'auto_withdraw_on_leave',
      );
      result.adsWithdrawn += ids.length;
      continue;
    }

    const tier = pickCurrentTier(tiers, probed.roles);
    if (!tier) {
      // Still in the guild but no supporter role — treat same as plan cancel.
      result.sponsorsLostTier++;
      const ids = await withdrawAllForSponsor(
        client,
        sponsorId,
        'sponsor tier role removed (auto-withdraw)',
        'auto_withdraw_on_lost_tier',
      );
      result.adsWithdrawn += ids.length;
      continue;
    }

    const changed = await syncWeightForSponsor(client, sponsorId, tier.weight);
    if (changed.length > 0) {
      result.sponsorsWeightSynced++;
      result.adsWeightChanged += changed.length;
    }
  }

  return result;
}
