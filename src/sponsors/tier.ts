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
     VALUES (?, ?, ?, (unixepoch() * 1000))
     ON CONFLICT (discord_user_id)
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   current_tier_id = EXCLUDED.current_tier_id,
                   updated_at = (unixepoch() * 1000)`,
    [args.userId, args.displayName, matched?.id ?? null],
  );

  return matched;
}

export async function countActiveAds(client: PgClient, sponsorId: string): Promise<number> {
  const res = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM ads
      WHERE sponsor_id = ?
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

export type EffectiveWeightsInput = { id: string; weightAlloc: number };
export type EffectiveWeightsResult = {
  weights: Array<{ id: string; weightSnapshot: number }>;
  paused: string[];
};

/**
 * Derive each banner's effective deck weight (`weight_snapshot`) from the
 * sponsor's intended allocations and the tier budget `tierWeight` (= T).
 *
 * Used IDENTICALLY by approve.ts and the audit cron so the two paths can
 * never drift. Pure: no DB, deterministic.
 *
 * - If S = Σ weightAlloc <= T: snapshot = alloc (upper-bound semantics; the
 *   unused budget T - S simply yields a smaller total share, never inflates).
 * - Else (S > T, e.g. after a downgrade): proportionally rescale
 *   snapshot_i = max(1, round(alloc_i * T / S)); the integer remainder is
 *   absorbed on the largest-alloc banner so Σ snapshot == T. If count > T the
 *   min-1 floor would still overshoot, so move smallest-alloc-first to
 *   'paused' until count <= T, then recompute over the survivors.
 */
export function effectiveWeights(
  allocs: EffectiveWeightsInput[],
  tierWeight: number,
): EffectiveWeightsResult {
  const S = allocs.reduce((sum, a) => sum + a.weightAlloc, 0);
  if (S <= tierWeight) {
    return {
      weights: allocs.map((a) => ({ id: a.id, weightSnapshot: a.weightAlloc })),
      paused: [],
    };
  }
  // S > T. If count exceeds the budget, the min-1 floor cannot fit: pause the
  // smallest-alloc banners first (ties broken by id, ascending — deterministic)
  // until count <= T, then recompute proportional weights over the survivors.
  const paused: string[] = [];
  let survivors = allocs.slice();
  while (survivors.length > tierWeight) {
    const victim = survivors
      .slice()
      .sort((x, y) => x.weightAlloc - y.weightAlloc || (x.id < y.id ? -1 : 1))[0];
    if (!victim) break;
    paused.push(victim.id);
    survivors = survivors.filter((a) => a.id !== victim.id);
  }
  const Ssurv = survivors.reduce((sum, a) => sum + a.weightAlloc, 0);
  // Map id -> alloc so we can order absorption by descending alloc.
  const allocById = new Map(survivors.map((a) => [a.id, a.weightAlloc]));
  const weights = survivors.map((a) => ({
    id: a.id,
    weightSnapshot: Math.max(1, Math.round((a.weightAlloc * tierWeight) / Ssurv)),
  }));
  // Absorb the integer remainder (can be NEGATIVE when rounding overshot) so
  // Σ weightSnapshot == tierWeight exactly. Apply it largest-alloc-first, but
  // NEVER let an absorber drop below the min weight of 1: when a negative
  // remainder would push the largest below 1, only take it down to 1 and roll
  // the residual onto the NEXT-largest survivor, and so on. survivors satisfy
  // count <= T (we paused until that held), so assigning each a floor of 1
  // leaves enough headroom that the residual is always fully absorbed and the
  // loop terminates with Σ == T and every weightSnapshot >= 1.
  let remainder = tierWeight - weights.reduce((sum, w) => sum + w.weightSnapshot, 0);
  if (remainder !== 0) {
    const order = weights
      .map((w, idx) => ({ idx, alloc: allocById.get(w.id) ?? 0, id: w.id }))
      .sort((x, y) => y.alloc - x.alloc || (x.id < y.id ? -1 : 1));
    for (const { idx } of order) {
      if (remainder === 0) break;
      const target = weights[idx];
      if (!target) continue;
      if (remainder > 0) {
        // Positive remainder: pile it all on the first (largest) absorber.
        target.weightSnapshot += remainder;
        remainder = 0;
      } else {
        // Negative remainder: subtract only down to the floor of 1, roll the rest.
        const canTake = target.weightSnapshot - 1; // >= 0
        const take = Math.min(canTake, -remainder);
        target.weightSnapshot -= take;
        remainder += take;
      }
    }
  }
  return { weights, paused };
}
