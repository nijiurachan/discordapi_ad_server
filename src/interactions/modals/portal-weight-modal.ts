import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import {
  findOpenPortalBySponsor,
  getSponsorActiveBanners,
  touchPortalActivity,
  updateAdWeightWithinBudget,
} from '../../db/queries/portal.ts';
import { applyEffectiveWeights, getSponsorActiveRegularAllocs } from '../../db/queries/review.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { ModalSubmitInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { buildPortalDashboard } from '../../services/portal/render.ts';
import { effectiveWeights, getSponsorBudget, refreshSponsorTier } from '../../sponsors/tier.ts';
import { ephemeral } from '../responses.ts';

export const WEIGHT_MODAL_PREFIX = 'portal:weight-modal:';

export type PortalWeightModalDeps = {
  rest: DiscordRest;
  client: PgClient;
  guildId: string;
};

function findTextValue(payload: ModalSubmitInteractionPayload, customId: string): string {
  for (const row of payload.data.components) {
    for (const comp of row.components) {
      if (comp.custom_id === customId) return comp.value;
    }
  }
  return '';
}

/**
 * Parse the weight input. Accepts only a base-10 non-negative integer literal;
 * '< 1', non-numeric, decimals, and overflow are rejected (Task 3 §3.C-3.1,
 * §5 'C 入力不正').
 */
function parseWeight(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/**
 * Core handler for `portal:weight-modal:{adId}` submissions (Task 3 C-3). Tests
 * inject deps; production wraps this with `withPgClient` + real REST in
 * `handlePortalWeightModal`.
 *
 * Ownership is enforced INSIDE the atomic UPDATE (WHERE sponsor_id = clicker),
 * so a non-owner submission yields changes=0 and is rejected without ever
 * mutating data — no separate ownership read is needed (mirrors the Phase 2
 * cross-sponsor lesson).
 */
export async function runPortalWeightModal(
  c: Context,
  payload: ModalSubmitInteractionPayload,
  deps: PortalWeightModalDeps,
): Promise<Response> {
  // 1. extract adId from custom_id
  const customId = payload.data.custom_id;
  if (!customId.startsWith(WEIGHT_MODAL_PREFIX)) {
    return ephemeral(c, '不正な custom_id です');
  }
  const adId = customId.slice(WEIGHT_MODAL_PREFIX.length);
  if (!adId) return ephemeral(c, '広告 ID を取得できません。');

  const clickerId = payload.member?.user.id ?? payload.user?.id ?? '';
  if (!clickerId) return ephemeral(c, 'ユーザー情報を取得できませんでした。');
  const displayName =
    payload.member?.user.username ?? payload.user?.username ?? clickerId ?? 'unknown';

  // 2. parse + validate input (§3.C-3.1: integer, >= 1; else ephemeral error)
  const newWeight = parseWeight(findTextValue(payload, 'weight'));
  if (newWeight === null) {
    return ephemeral(c, '重みは 1 以上の整数で入力してください。');
  }

  // 3. atomic ownership + budget guarded UPDATE (§3.C-3.2). changes==0 ⇒ budget
  // exceeded OR not the owner OR the ad is gone/terminal. We do NOT recalc or
  // re-render in that case.
  const applied = await updateAdWeightWithinBudget(deps.client, adId, clickerId, newWeight);
  if (!applied) {
    return ephemeral(
      c,
      '重みを変更できませんでした。残りウェイト予算を超えているか、対象のバナーが見つかりません。',
    );
  }

  // 4. recalc effectiveWeights for the whole sponsor and persist weight_snapshot
  // (§3.C-3.3 — REUSE getSponsorActiveRegularAllocs + effectiveWeights +
  // applyEffectiveWeights, the single source of truth shared with approve/cron).
  // serve_rotation's signature changes ⇒ next /serve rebuilds the deck.
  // Single budget read: the value is identical before/after applyEffectiveWeights
  // because the guard guarantees Σalloc <= tierWeight (so no banner is paused) and
  // applyEffectiveWeights only writes weight_snapshot, which sumActiveWeight (over
  // weight_alloc) never reads. Reuse it for both the recalc tierWeight and the
  // confirmation 'remaining'.
  const budget = await getSponsorBudget(deps.client, clickerId);
  if (budget) {
    const allocs = await getSponsorActiveRegularAllocs(deps.client, clickerId);
    const eff = effectiveWeights(allocs, budget.tierWeight);
    await applyEffectiveWeights(deps.client, eff.weights, eff.paused);
  }
  const remaining = budget?.remaining ?? 0;

  // 5. re-render the dashboard in place (§3.C-3.4 — REUSE findOpenPortalBySponsor
  // + buildPortalDashboard + editMessage + touchPortalActivity). Skip silently if
  // there is no open portal row or no persisted dashboard message; the data is
  // already updated.
  const portal = await findOpenPortalBySponsor(deps.client, clickerId);
  if (portal?.dashboardMessageId) {
    try {
      // Resolve the real plan name the same way the portal:refresh arm does so
      // the dashboard's 'プラン' field shows the tier (not the unassigned
      // fallback) for tiered sponsors. Mirror refresh's try/catch fallback.
      let tierName: string | null = null;
      try {
        const tier = await refreshSponsorTier({
          rest: deps.rest,
          client: deps.client,
          guildId: deps.guildId,
          userId: clickerId,
          displayName,
        });
        tierName = tier?.name ?? null;
      } catch (err) {
        console.error('portal-weight-modal: refreshSponsorTier failed', {
          userId: clickerId,
          err,
        });
      }
      const banners = await getSponsorActiveBanners(deps.client, clickerId);
      const dashboard = buildPortalDashboard({
        tierName,
        budget,
        maxActiveAds: budget?.tierWeight ?? 0,
        usedCount: banners.length,
        banners,
      });
      await deps.rest.editMessage(portal.channelId, portal.dashboardMessageId, {
        embeds: dashboard.embeds,
        components: dashboard.components,
      });
      await touchPortalActivity(deps.client, portal.id);
    } catch (err) {
      console.error('portal-weight-modal: dashboard re-render failed', {
        portalId: portal.id,
        err,
      });
    }
  }

  // 6. ephemeral confirmation (§3.C-3.5).
  return ephemeral(c, `✅ 重みを変更しました（残りウェイト ${remaining}）`);
}

/**
 * Production entry point: builds the REST client from env, opens a db pool
 * scoped to the request, and delegates to `runPortalWeightModal`.
 */
export async function handlePortalWeightModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  const guildId = payload.guild_id ?? env.GUILD_ID;
  return withPgClient(env, (client) => runPortalWeightModal(c, payload, { rest, client, guildId }));
}
