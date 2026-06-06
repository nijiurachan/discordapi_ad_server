import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { SystemSettingKey, getSystemSetting, setSystemSetting } from '../../db/settings.ts';
import { buildAdminMenuMessage } from '../../discord/admin-menu.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type {
  ActionRowComponent,
  ApplicationCommandInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { type FormatRules, fetchFormatRules } from '../../validation/rules.ts';
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

/**
 * Render the key constraints of a slot's format rules as a Markdown block.
 * Designed to be inlined into the submit menu so applicants see required
 * dimensions / aspect ratios / file caps without an extra button click.
 * Compact (~250 chars) to stay well under Discord's 2000-char content limit.
 */
function formatRulesSummary(rules: FormatRules): string {
  const lines: string[] = [`### 📐 入稿ルール（slot=${rules.slot}）`];
  lines.push(`• 形式: ${rules.allowedMimes.join(', ')}`);
  const hasSize =
    rules.minWidth != null ||
    rules.maxWidth != null ||
    rules.minHeight != null ||
    rules.maxHeight != null;
  if (hasSize) {
    const w = `${rules.minWidth ?? '?'}–${rules.maxWidth ?? '?'}`;
    const h = `${rules.minHeight ?? '?'}–${rules.maxHeight ?? '?'}`;
    lines.push(`• サイズ: ${w} × ${h} px`);
  }
  lines.push(`• ファイル: 最大 ${(rules.maxBytes / 1024 / 1024).toFixed(1)} MB`);
  if (rules.aspectRatios && rules.aspectRatios.length > 0) {
    const tolPct = Math.round((rules.aspectTolerance ?? 0.02) * 100);
    lines.push(`• アスペクト比: ${rules.aspectRatios.join(', ')}（±${tolPct}%）`);
  }
  lines.push(
    `• タイトル ≤ ${rules.titleMaxLen} / 本文 ≤ ${rules.bodyMaxLen} / リンク ${rules.linkScheme.join('/')} のみ`,
  );
  lines.push(
    '• 🔁 **配信時は 468 × 60 px に自動リサイズ** されます（高解像度入稿は Retina 用ソースとして受理）',
  );
  return lines.join('\n');
}

function buildSubmitMenu(rules: FormatRules | null): {
  content: string;
  components: ActionRowComponent[];
} {
  const rulesBlock = rules
    ? `\n\n${formatRulesSummary(rules)}`
    : '\n\n_（入稿ルール未設定 — 管理者が「📐 入稿ルール」で設定するとここに表示されます）_';
  return {
    content: `## 📣 広告起稿システム

起稿は下のチャット欄から \`/ad submit\`
（slot を選び、image に画像を添付してください）
添付後、タイトル / 本文 / リンクの入力画面が開きます。${rulesBlock}`,
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

  if (kind === 'review') {
    return ephemeral(c, 'review メニューは後続フェーズで対応します。');
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

  // Post new menu. For the submit menu, look up the default-slot rules so
  // applicants see required dimensions / aspect ratios / file caps inline.
  // (Re-run `/ad-setup kind:submit` after editing rules to refresh.)
  // The two builders return different message shapes (content vs. embeds);
  // `createMessage` accepts either as a JSON body, so widen via `Record`.
  const menu: Record<string, unknown> =
    kind === 'admin'
      ? buildAdminMenuMessage()
      : buildSubmitMenu(await fetchFormatRules(deps.client, 'default'));
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
  return withPgClient(env, (client) => runAdSetup(c, payload, { rest, client, actorId }));
}
