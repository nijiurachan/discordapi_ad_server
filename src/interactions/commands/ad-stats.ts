import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { type StatsPeriod, getAggregateStats } from '../../db/queries/ads.ts';
import type {
  ApplicationCommandInteractionPayload,
  MessageComponentInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { formatPercent } from '../format.ts';
import { ephemeral } from '../responses.ts';

const ALLOWED_PERIODS: readonly StatsPeriod[] = ['24h', '7d', '30d', 'all'] as const;

const PERIOD_LABEL: Record<StatsPeriod, string> = {
  '24h': '直近 24 時間',
  '7d': '直近 7 日',
  '30d': '直近 30 日',
  all: '全期間',
};

export type AdStatsDeps = {
  client: PgClient;
};

export async function runAdStats(
  c: Context,
  userId: string,
  period: StatsPeriod,
  deps: AdStatsDeps,
): Promise<Response> {
  const stats = await getAggregateStats(deps.client, userId, period);
  const content =
    `📊 **${PERIOD_LABEL[period]} の統計**\n` +
    `広告数: ${stats.adCount}\n` +
    `インプレッション: ${stats.impressions.toLocaleString()}\n` +
    `クリック: ${stats.clicks.toLocaleString()}\n` +
    `CTR: ${formatPercent(stats.ctr)}`;
  return ephemeral(c, content);
}

export function periodSelectMenuResponse(c: Context): Response {
  return c.json({
    type: 4,
    data: {
      content: '統計を確認したい期間を選択してください:',
      components: [
        {
          type: 1, // ACTION_ROW
          components: [
            { type: 2, style: 2, custom_id: 'ad:stats:24h', label: '24時間' },
            { type: 2, style: 2, custom_id: 'ad:stats:7d', label: '7日' },
            { type: 2, style: 2, custom_id: 'ad:stats:30d', label: '30日' },
            { type: 2, style: 2, custom_id: 'ad:stats:all', label: '全期間' },
          ],
        },
      ],
      flags: 64, // EPHEMERAL
    },
  });
}

export async function handleAdStatsCommand(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
): Promise<Response> {
  const userId = payload.member?.user.id ?? payload.user?.id;
  if (!userId) return ephemeral(c, 'ユーザー情報を取得できませんでした');
  const sub = payload.data.options?.find((o) => o.name === 'stats');
  const periodOpt = sub?.options?.find((o) => o.name === 'period');
  const periodRaw = typeof periodOpt?.value === 'string' ? periodOpt.value : '7d';
  const period: StatsPeriod = (ALLOWED_PERIODS as readonly string[]).includes(periodRaw)
    ? (periodRaw as StatsPeriod)
    : '7d';
  return withPgClient(c.env.POSTGRES_URL, (client) => runAdStats(c, userId, period, { client }));
}

export async function handleAdStatsButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  const userId = payload.member?.user.id ?? payload.user?.id;
  if (!userId) return ephemeral(c, 'ユーザー情報を取得できませんでした');
  // custom_id: ad:stats:period (show menu) | ad:stats:{period} (run query)
  const parts = payload.data.custom_id.split(':');
  const tail = parts[2] ?? '';
  if (tail === 'period') {
    return periodSelectMenuResponse(c);
  }
  if ((ALLOWED_PERIODS as readonly string[]).includes(tail)) {
    return withPgClient(c.env.POSTGRES_URL, (client) =>
      runAdStats(c, userId, tail as StatsPeriod, { client }),
    );
  }
  return ephemeral(c, '不明な統計期間です');
}
