import type { PgClient } from '../../db/client.ts';
import type { ActiveBanner } from '../../db/queries/portal.ts';
import { setPortalDashboardMessageId } from '../../db/queries/portal.ts';
import type { DiscordRest } from '../../discord/rest.ts';
import type { SponsorBudget } from '../../sponsors/tier.ts';

export type PortalDashboardMessage = {
  embeds: Record<string, unknown>[];
  components: Record<string, unknown>[];
};

const STATUS_LABEL: Record<string, string> = {
  approved: '配信中',
  pending: '審査中',
};

function dashboardButtons(): Record<string, unknown> {
  return {
    type: 1,
    components: [
      { type: 2, style: 1, custom_id: 'portal:add', label: '➕ バナーを追加' },
      { type: 2, style: 2, custom_id: 'portal:manage', label: '🗂 管理' },
      { type: 2, style: 2, custom_id: 'portal:refresh', label: '🔄 更新' },
      { type: 2, style: 4, custom_id: 'portal:close', label: '✖ 閉じる' },
    ],
  };
}

/**
 * Pure builder for the portal dashboard (embed + button row). Re-rendered on
 * every open/operation since there's no push channel.
 */
export function buildPortalDashboard(args: {
  tierName: string | null;
  budget: SponsorBudget | null;
  maxActiveAds: number;
  usedCount: number;
  banners: ActiveBanner[];
}): PortalDashboardMessage {
  const planValue = args.tierName ?? '（ティアロール未付与）';
  const remainingValue =
    args.budget === null
      ? 'ティアロールが付与されていません'
      : `残り ${args.budget.remaining} / ${args.budget.tierWeight}（使用 ${args.budget.used}）`;
  const capValue = `${args.usedCount} / ${args.maxActiveAds}`;
  const bannerValue =
    args.banners.length === 0
      ? '_出稿中のバナーはありません_'
      : args.banners
          .map((b) => {
            const status = STATUS_LABEL[b.status] ?? b.status;
            const w = b.weightAlloc ?? 0;
            return `• ${b.title}（${status}・weight ${w}・slot ${b.slot}）`;
          })
          .join('\n');

  return {
    embeds: [
      {
        title: '📣 広告ポータル',
        color: 0x5865f2,
        fields: [
          { name: 'プラン', value: planValue, inline: true },
          { name: '残り利用可能ウェイト', value: remainingValue, inline: true },
          { name: '件数（使用 / 上限）', value: capValue, inline: true },
          { name: '出稿中バナー', value: bannerValue.slice(0, 1024) },
        ],
      },
    ],
    components: [dashboardButtons()],
  };
}

/**
 * Post the dashboard message (and persist its id) when none exists yet, or
 * edit the existing message in place.
 */
export async function renderPortalDashboard(args: {
  client: PgClient;
  rest: DiscordRest;
  portalId: string;
  channelId: string;
  dashboardMessageId: string | null;
  dashboard: PortalDashboardMessage;
}): Promise<string> {
  if (args.dashboardMessageId) {
    await args.rest.editMessage(args.channelId, args.dashboardMessageId, {
      embeds: args.dashboard.embeds,
      components: args.dashboard.components,
    });
    return args.dashboardMessageId;
  }
  const msg = await args.rest.createMessage(args.channelId, {
    embeds: args.dashboard.embeds,
    components: args.dashboard.components,
  });
  await setPortalDashboardMessageId(args.client, args.portalId, msg.id);
  return msg.id;
}
