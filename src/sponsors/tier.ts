import type { PgClient } from '../db/client.ts';
import type { DiscordRest } from '../discord/rest.ts';

export type Tier = {
  id: number;
  discordRoleId: string;
  name: string;
  weight: number;
  maxActiveAds: number;
  rank: number;
};

export type TierResolution =
  | { tier: Tier; activeCount: number }
  | { tier: null; reason: 'no_tier_role' };

export type RefreshSponsorTierArgs = {
  rest: DiscordRest;
  client: PgClient;
  guildId: string;
  userId: string;
  displayName: string;
};

/**
 * Pull the user's current roles from Discord, intersect with tiers table,
 * pick the highest-rank match, UPSERT the sponsor row, return the tier.
 */
export async function refreshSponsorTier(args: RefreshSponsorTierArgs): Promise<Tier | null> {
  // 1. Discord REST GET /guilds/{guildId}/members/{userId}
  const member = await args.rest.getGuildMember(args.guildId, args.userId);

  // 2. Pull all tiers from DB sorted by rank desc
  const allTiers = await args.client.query<Tier>(
    `SELECT id, discord_role_id AS "discordRoleId", name, weight,
            max_active_ads AS "maxActiveAds", rank
       FROM tiers ORDER BY rank DESC`,
  );

  // 3. Find highest-rank tier whose discord_role_id is in member.roles
  const memberRoles = new Set(member.roles ?? []);
  const matched = allTiers.rows.find((t) => memberRoles.has(t.discordRoleId)) ?? null;

  // 4. UPSERT sponsor row (display_name updated even if tier unchanged or null)
  await args.client.query(
    `INSERT INTO sponsors (discord_user_id, display_name, current_tier_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (discord_user_id)
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   current_tier_id = EXCLUDED.current_tier_id,
                   updated_at = now()`,
    [args.userId, args.displayName, matched?.id ?? null],
  );

  return matched;
}

export async function countActiveAds(client: PgClient, sponsorId: string): Promise<number> {
  const res = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM ads
      WHERE sponsor_id = $1
        AND status IN ('approved', 'pending')`,
    [sponsorId],
  );
  return Number(res.rows[0]?.count ?? 0);
}

export type MaxActiveAdsCheckResult = { ok: true } | { ok: false; message: string };

export function checkMaxActiveAds(tier: Tier, activeCount: number): MaxActiveAdsCheckResult {
  if (activeCount >= tier.maxActiveAds) {
    return {
      ok: false,
      message:
        `現在のティア「${tier.name}」では同時に最大 ${tier.maxActiveAds} 件まで配信できます。` +
        `（既に ${activeCount} 件あります）`,
    };
  }
  return { ok: true };
}
