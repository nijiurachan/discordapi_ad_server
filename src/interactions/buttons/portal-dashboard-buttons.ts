import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { getAdSponsorId } from '../../db/queries/ads.ts';
import {
  findOpenPortalByChannel,
  getSponsorActiveBanners,
  touchPortalActivity,
} from '../../db/queries/portal.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload, ModalResponse } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { buildPortalDashboard } from '../../services/portal/render.ts';
import { closePortal } from '../../services/portal/teardown.ts';
import { getSponsorBudget, refreshSponsorTier } from '../../sponsors/tier.ts';
import { WEIGHT_MODAL_PREFIX } from '../modals/portal-weight-modal.ts';
import { ephemeral, modalResponse, updateMessage } from '../responses.ts';

export type PortalDashboardDeps = {
  rest: DiscordRest;
  client: PgClient;
  guildId: string;
};

const ADD_HELP =
  '➕ バナーの追加は `/ad submit` から行います。\n' +
  'slot を選び画像を添付すると、タイトル / 本文 / リンクの入力画面が開きます。\n' +
  '（残り利用可能ウェイトが 0 の場合は追加できません。）';

// Discord limits a message to 5 ACTION_ROWs. The management view renders one
// '重み変更' button per banner, one button per row, so at most 5 banners can
// carry an edit button. Overflow is noted and the sponsor is pointed at
// `/ad withdraw` / `/ad list` for the rest.
const MAX_WEIGHT_BUTTONS = 5;

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

  // portal:weight:<adId> — open the weight-change modal for a single banner.
  // Ownership: resolve the ad and confirm its sponsor_id == clicker BEFORE
  // returning the modal (Phase 2 cross-sponsor lesson). The modal's custom_id
  // carries the adId so the submit handler (C-3) recovers it without a round-trip.
  if (cid.startsWith('portal:weight:')) {
    const adId = cid.slice('portal:weight:'.length);
    if (!adId) return ephemeral(c, '広告 ID を取得できません。');
    const ownerId = await getAdSponsorId(deps.client, adId);
    if (ownerId === null) {
      return ephemeral(c, '対象のバナーが見つかりません。既に終了した可能性があります。');
    }
    if (ownerId !== userId) {
      return ephemeral(c, 'この操作を行えるのは対象のスポンサーのみです。');
    }
    const modal: ModalResponse = {
      custom_id: `${WEIGHT_MODAL_PREFIX}${adId}`,
      title: '⚖ 重みを変更',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'weight',
              label: '新しい重み（1以上）',
              style: 1, // SHORT
              required: true,
              min_length: 1,
              max_length: 4,
              placeholder: '例: 3',
            },
          ] as const,
        },
      ],
    };
    return modalResponse(c, modal);
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

    // One '重み変更' button per banner, capped at MAX_WEIGHT_BUTTONS (Discord's
    // 5-ACTION_ROW limit since each button sits on its own row). Overflow is
    // noted; the remaining banners are still listed in the text above.
    const shown = banners.slice(0, MAX_WEIGHT_BUTTONS);
    const components = shown.map((b) => ({
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          custom_id: `portal:weight:${b.id}`,
          label: `⚖ 重み変更: ${b.title}`.slice(0, 80),
        },
      ],
    }));
    const overflowNote =
      banners.length > MAX_WEIGHT_BUTTONS
        ? `\n\n_先頭 ${MAX_WEIGHT_BUTTONS} 件のみボタンを表示しています。残りは \`/ad list\` で確認してください。_`
        : '';

    return ephemeral(
      c,
      `🗂 出稿中バナーの管理\n${lines}\n\n各バナーの「重み変更」ボタンから weight を変更できます。\n取り下げは \`/ad withdraw id:<広告ID>\` で行えます。${overflowNote}`,
      components,
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
