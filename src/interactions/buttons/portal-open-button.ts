import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import {
  findPortalById,
  getSponsorActiveBanners,
  touchPortalActivity,
} from '../../db/queries/portal.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { openOrReusePortalChannel } from '../../services/portal/open.ts';
import { buildPortalDashboard, renderPortalDashboard } from '../../services/portal/render.ts';
import { getSponsorBudget, refreshSponsorTier } from '../../sponsors/tier.ts';
import { deferredEphemeral } from '../responses.ts';

export type PortalOpenDeps = {
  rest: DiscordRest;
  /**
   * Opens a FRESH PgClient for the duration of `fn`. In production this is
   * `(fn) => withPgClient(env, fn)`. The scheduled (post-ACK) work calls this
   * INSIDE the waitUntil callback so it never reuses the request-scoped client
   * (which D1 would tear down when the request handler returns its Response).
   */
  withClient: <T>(fn: (client: PgClient) => Promise<T>) => Promise<T>;
  // Schedules the post-ACK open/render/followup work outside the 3-second
  // interaction window. In production this is `(p) => c.executionCtx.waitUntil(p)`
  // (mirrors review-approve-button / review-reject-modal). The Hono Context's
  // `executionCtx` is getter-only at runtime, so it is injected here rather than
  // mutated on the Context. Tests inject a recorder to assert the work is
  // scheduled (not awaited inline).
  waitUntil: (p: Promise<unknown>) => void;
  appId: string;
  guildId: string;
  botId: string;
  categoryId: string;
  reviewerRoleId: string;
  adminRoleId: string;
  uuid: () => string;
};

/**
 * Build + render the dashboard for a freshly opened/reused portal, then push a
 * webhook followup linking the channel. Runs inside waitUntil (post-ACK) and is
 * handed a FRESH `client` opened inside the waitUntil callback (NOT the
 * request-scoped one).
 */
async function fulfillPortalOpen(
  client: PgClient,
  token: string,
  sponsorId: string,
  displayName: string,
  deps: PortalOpenDeps,
): Promise<void> {
  // Live tier refresh (accurate plan name; matches ad-submit's lazy refresh).
  let tierName: string | null = null;
  try {
    const tier = await refreshSponsorTier({
      rest: deps.rest,
      client,
      guildId: deps.guildId,
      userId: sponsorId,
      displayName,
    });
    tierName = tier?.name ?? null;
  } catch (err) {
    console.error('portal open: refreshSponsorTier failed', { sponsorId, err });
  }

  // First-time-user FK guard: refreshSponsorTier above is the only path that
  // upserts the sponsors row, and its failure is swallowed (transient 5xx /
  // rate-limit / user left the guild). createPortalRow then violates the
  // sponsors FK (D1 enforces foreign_keys), giving an opaque failure. Run an
  // idempotent INSERT so the row always exists before we open the channel;
  // ON CONFLICT DO NOTHING makes it a no-op when refreshSponsorTier succeeded
  // (matches admin-submit.ts's sponsor-row guard).
  try {
    await client.query(
      `INSERT INTO sponsors (discord_user_id, display_name)
         VALUES (?, ?)
       ON CONFLICT (discord_user_id) DO NOTHING`,
      [sponsorId, displayName || sponsorId],
    );
  } catch (err) {
    console.error('portal open: sponsor-row guard INSERT failed', { sponsorId, err });
  }

  const opened = await openOrReusePortalChannel({
    client,
    rest: deps.rest,
    guildId: deps.guildId,
    botId: deps.botId,
    categoryId: deps.categoryId,
    sponsorId,
    reviewerRoleId: deps.reviewerRoleId,
    adminRoleId: deps.adminRoleId,
    uuid: deps.uuid,
  });
  if (!opened.ok) {
    await deps.rest.editOriginalInteractionResponse(deps.appId, token, {
      content: '⚠ ポータルを開けませんでした。しばらくしてから再度お試しください。',
    });
    return;
  }

  // The channel now exists. Every path past this point MUST send exactly one
  // editOriginalInteractionResponse — otherwise the deferred ephemeral is stuck
  // "thinking…" forever and the created channel is orphaned. Wrap the post-open
  // reads/render so any throw still surfaces a followup pointing at the channel.
  try {
    const [budget, banners] = await Promise.all([
      getSponsorBudget(client, sponsorId),
      getSponsorActiveBanners(client, sponsorId),
    ]);

    // used-count numerator = regular non-admin pending+approved banner count
    // (banners.length), NOT the broad countActiveAds (which counts all kinds).
    // cap denominator = tierWeight (each banner ≥1 weight and Σ≤tierWeight ⇒
    // count≤tierWeight). `remaining` is shown separately via budget.remaining.
    const dashboard = buildPortalDashboard({
      tierName,
      budget,
      maxActiveAds: budget?.tierWeight ?? 0,
      usedCount: banners.length,
      banners,
    });

    // dashboardMessageId may be stale after a self-heal; re-read the row when we
    // reused so we don't try to edit a message in a different (deleted) channel.
    let dashboardMessageId = opened.dashboardMessageId;
    if (opened.reusedExisting) {
      const fresh = await findPortalById(client, opened.portalId);
      dashboardMessageId = fresh?.dashboardMessageId ?? null;
    }

    try {
      await renderPortalDashboard({
        client,
        rest: deps.rest,
        portalId: opened.portalId,
        channelId: opened.channelId,
        dashboardMessageId,
        dashboard,
      });
      await touchPortalActivity(client, opened.portalId);
    } catch (err) {
      console.error('portal open: renderPortalDashboard failed', {
        portalId: opened.portalId,
        err,
      });
    }

    await deps.rest.editOriginalInteractionResponse(deps.appId, token, {
      content: `✅ 広告ポータルを開きました: <#${opened.channelId}>`,
    });
  } catch (err) {
    // Post-open work (budget/banner reads) threw. The channel still exists, so
    // point the sponsor at it instead of leaving the deferred ACK hanging.
    console.error('portal open: post-open work failed', { portalId: opened.portalId, err });
    await deps.rest.editOriginalInteractionResponse(deps.appId, token, {
      content: `⚠ ポータルは開きましたが情報の取得に失敗しました: <#${opened.channelId}>`,
    });
  }
}

export async function runPortalOpenButton(
  c: Context,
  payload: MessageComponentInteractionPayload,
  deps: PortalOpenDeps,
): Promise<Response> {
  const sponsorId = payload.member?.user.id ?? payload.user?.id ?? '';
  const displayName =
    payload.member?.user.username ?? payload.user?.username ?? sponsorId ?? 'unknown';
  const token = payload.token;
  if (sponsorId && token) {
    // Open a FRESH withPgClient INSIDE the scheduled callback. We deliberately
    // do NOT reuse a request-scoped client: the channel-create + dashboard work
    // outlives the request, and D1 ties a client to the request that opened it.
    // The work is handed to waitUntil so the deferred ACK below returns inside
    // Discord's 3-second window (mirrors review-approve-button's deferred path).
    deps.waitUntil(
      (async () => {
        try {
          await deps.withClient((client) =>
            fulfillPortalOpen(client, token, sponsorId, displayName, deps),
          );
        } catch (err) {
          console.error('portal open: scheduled work failed', { sponsorId, err });
        }
      })(),
    );
  }
  // ACK within 3s no matter what; failures surface via the followup.
  return deferredEphemeral(c);
}

export function handlePortalOpenButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  const guildId = payload.guild_id ?? env.GUILD_ID;
  // No request-scoped client here. The scheduled work opens its own fresh client
  // via `withClient` inside the waitUntil callback (see runPortalOpenButton).
  return runPortalOpenButton(c, payload, {
    rest,
    withClient: (fn) => withPgClient(env, fn),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
    appId: env.DISCORD_APP_ID,
    guildId,
    botId: env.DISCORD_APP_BOT_ID,
    categoryId: env.PORTAL_CHANNEL_CATEGORY_ID,
    reviewerRoleId: env.REVIEWER_ROLE_ID,
    adminRoleId: env.ADMIN_ROLE_ID,
    uuid: () => crypto.randomUUID(),
  });
}
