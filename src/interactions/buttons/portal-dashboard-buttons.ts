import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import {
  findOpenPortalByChannel,
  getSponsorActiveBanners,
  touchPortalActivity,
} from '../../db/queries/portal.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { buildPortalDashboard } from '../../services/portal/render.ts';
import { closePortal } from '../../services/portal/teardown.ts';
import { getSponsorBudget, refreshSponsorTier } from '../../sponsors/tier.ts';
import { ephemeral, updateMessage } from '../responses.ts';

export type PortalDashboardDeps = {
  rest: DiscordRest;
  client: PgClient;
  guildId: string;
};

const ADD_HELP =
  '➕ バナーの追加は `/ad submit` から行います。\n' +
  'slot を選び画像を添付すると、タイトル / 本文 / リンクの入力画面が開きます。\n' +
  '（残り利用可能ウェイトが 0 の場合は追加できません。）';

export async function runPortalDashboardButton(
  c: Context,
  payload: MessageComponentInteractionPayload,
  deps: PortalDashboardDeps,
): Promise<Response> {
  const cid = payload.data.custom_id;
  const userId = payload.member?.user.id ?? payload.user?.id ?? '';
  const displayName =
    payload.member?.user.username ?? payload.user?.username ?? userId ?? 'unknown';
  if (!userId) return ephemeral(c, 'ユーザー情報を取得できませんでした。');

  if (cid === 'portal:add') {
    return ephemeral(c, ADD_HELP);
  }

  if (cid === 'portal:close') {
    // Owner check must use the channel the button was clicked in (payload
    // .channel_id), NOT findOpenPortalBySponsor(clickerUserId) — otherwise a
    // non-owner would only ever look up their own portal and the not_owner
    // branch is unreachable. We look the portal up by channel and compare its
    // stored sponsor_id to the clicker inside closePortal.
    const channelId = payload.channel_id ?? '';
    const portal = channelId ? await findOpenPortalByChannel(deps.client, channelId) : null;
    if (!portal) return ephemeral(c, 'ポータルが見つかりません。既に閉じられた可能性があります。');
    const res = await closePortal({
      client: deps.client,
      rest: deps.rest,
      portalId: portal.id,
      userId,
    });
    if (!res.ok && res.reason === 'not_owner') {
      return ephemeral(c, 'この操作を行えるのは対象のスポンサーのみです。');
    }
    if (!res.ok) {
      return ephemeral(c, 'ポータルが見つかりません。既に閉じられた可能性があります。');
    }
    return ephemeral(c, '✅ ポータルを閉じました。チャンネルは削除されます。');
  }

  if (cid === 'portal:manage') {
    // Resolve by the channel the button was clicked in (NOT the clicker) and
    // gate on ownership: staff can VIEW any portal, so keying the banner list on
    // the clicker would leak the clicker's banners into another sponsor's
    // channel. Mirror portal:close's resolve+check.
    const channelId = payload.channel_id ?? '';
    const portal = channelId ? await findOpenPortalByChannel(deps.client, channelId) : null;
    if (!portal) return ephemeral(c, 'ポータルが見つかりません。');
    if (portal.sponsorId !== userId) {
      return ephemeral(c, 'この操作を行えるのは対象のスポンサーのみです。');
    }
    const banners = await getSponsorActiveBanners(deps.client, portal.sponsorId);
    const lines =
      banners.length === 0
        ? '_管理対象のバナーはありません_'
        : banners
            .map((b) => `• \`${b.id}\` ${b.title}（${b.status}・weight ${b.weightAlloc ?? 0}）`)
            .join('\n');
    return ephemeral(
      c,
      `🗂 出稿中バナーの管理\n${lines}\n\n取り下げは \`/ad withdraw id:<広告ID>\` で行えます。`,
    );
  }

  // portal:refresh — re-render the dashboard in place (type 7).
  // Resolve by the clicked channel and gate on ownership: staff can VIEW any
  // portal, so keying the dashboard on the clicker would overwrite another
  // sponsor's dashboard with the clicker's private budget/banners. Mirror
  // portal:close's resolve+check.
  const channelId = payload.channel_id ?? '';
  const portal = channelId ? await findOpenPortalByChannel(deps.client, channelId) : null;
  if (!portal) return ephemeral(c, 'ポータルが見つかりません。');
  if (portal.sponsorId !== userId) {
    return ephemeral(c, 'この操作を行えるのは対象のスポンサーのみです。');
  }
  const ownerId = portal.sponsorId;

  let tierName: string | null = null;
  try {
    const tier = await refreshSponsorTier({
      rest: deps.rest,
      client: deps.client,
      guildId: deps.guildId,
      userId: ownerId,
      displayName,
    });
    tierName = tier?.name ?? null;
  } catch (err) {
    console.error('portal refresh: refreshSponsorTier failed', { userId: ownerId, err });
  }

  const [budget, banners] = await Promise.all([
    getSponsorBudget(deps.client, ownerId),
    getSponsorActiveBanners(deps.client, ownerId),
  ]);

  await touchPortalActivity(deps.client, portal.id);

  // used-count numerator = banners.length (regular non-admin pending+approved),
  // NOT countActiveAds; cap = tierWeight; remaining shown separately.
  const dashboard = buildPortalDashboard({
    tierName,
    budget,
    maxActiveAds: budget?.tierWeight ?? 0,
    usedCount: banners.length,
    banners,
  });
  return updateMessage(c, {
    embeds: dashboard.embeds,
    components: dashboard.components,
  });
}

export async function handlePortalDashboardButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  const guildId = payload.guild_id ?? env.GUILD_ID;
  return withPgClient(env, (client) =>
    runPortalDashboardButton(c, payload, { rest, client, guildId }),
  );
}
