import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { SystemSettingKey, getSystemSetting, setSystemSetting } from '../../db/settings.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type {
  ActionRowComponent,
  ApplicationCommandInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { ephemeral } from '../responses.ts';

export type AdSetupDeps = {
  rest: DiscordRest;
  client: PgClient;
  actorId: string;
};

const ADMINISTRATOR_BIT = 0x8n;

function hasAdministrator(permissions: string | undefined): boolean {
  if (!permissions) return false;
  try {
    return (BigInt(permissions) & ADMINISTRATOR_BIT) !== 0n;
  } catch {
    return false;
  }
}

type MenuKind = 'submit' | 'review' | 'admin';

const MESSAGE_KEY: Record<MenuKind, string> = {
  submit: SystemSettingKey.SUBMIT_MENU_MESSAGE_ID,
  review: SystemSettingKey.REVIEW_MENU_MESSAGE_ID,
  admin: SystemSettingKey.ADMIN_MENU_MESSAGE_ID,
};

const CHANNEL_KEY: Record<MenuKind, string> = {
  submit: SystemSettingKey.SUBMIT_MENU_CHANNEL_ID,
  review: SystemSettingKey.REVIEW_MENU_CHANNEL_ID,
  admin: SystemSettingKey.ADMIN_MENU_CHANNEL_ID,
};

function buildSubmitMenu(): { content: string; components: ActionRowComponent[] } {
  return {
    content:
      '## 📣 広告起稿システム\n\n' +
      '起稿は下のチャット欄から `/ad submit`\n' +
      '（slot を選び、image に画像を添付してください）\n' +
      '添付後、タイトル / 本文 / リンクの入力画面が開きます。',
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, custom_id: 'ad:list', label: '📋 自分の広告一覧' },
          { type: 2, style: 2, custom_id: 'ad:stats:period', label: '📊 統計' },
          { type: 2, style: 2, custom_id: 'ad:rules', label: '📐 入稿ルール' },
          { type: 2, style: 2, custom_id: 'ad:help', label: '❓ 起稿の手順を見る' },
        ],
      },
    ],
  };
}

export async function runAdSetup(
  c: Context,
  payload: ApplicationCommandInteractionPayload,
  deps: AdSetupDeps,
): Promise<Response> {
  if (!hasAdministrator(payload.member?.permissions)) {
    return ephemeral(c, '⚠ この操作には Administrator 権限が必要です。');
  }
  const opts = payload.data.options ?? [];
  const channelOpt = opts.find((o) => o.name === 'channel');
  const kindOpt = opts.find((o) => o.name === 'kind');
  const channelId = typeof channelOpt?.value === 'string' ? channelOpt.value : '';
  const kindRaw = typeof kindOpt?.value === 'string' ? kindOpt.value : '';
  if (!channelId || !['submit', 'review', 'admin'].includes(kindRaw)) {
    return ephemeral(c, 'channel と kind が必須です');
  }
  const kind = kindRaw as MenuKind;

  if (kind !== 'submit') {
    return ephemeral(
      c,
      `${kind} メニューは後続フェーズで対応します。現状は submit のみ実装済みです。`,
    );
  }

  // Delete previous menu if it exists
  const oldMessageId = await getSystemSetting<string>(deps.client, MESSAGE_KEY[kind]);
  const oldChannelId = await getSystemSetting<string>(deps.client, CHANNEL_KEY[kind]);
  if (oldMessageId && oldChannelId) {
    try {
      await deps.rest.deleteMessage(oldChannelId, oldMessageId);
    } catch (err) {
      console.warn('ad-setup: old menu delete failed (likely already gone)', {
        oldMessageId,
        err,
      });
    }
  }

  // Post new menu
  const menu = buildSubmitMenu();
  const message = await deps.rest.createMessage(channelId, menu);

  // Persist new message_id + channel_id
  await setSystemSetting(deps.client, MESSAGE_KEY[kind], message.id, deps.actorId);
  await setSystemSetting(deps.client, CHANNEL_KEY[kind], channelId, deps.actorId);

  return ephemeral(c, `✅ ${kind} メニューを <#${channelId}> に投稿しました。`);
}

export async function handleAdSetup(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  const actorId = payload.member?.user.id ?? payload.user?.id ?? 'unknown';
  return withPgClient(env.POSTGRES_URL, (client) =>
    runAdSetup(c, payload, { rest, client, actorId }),
  );
}
