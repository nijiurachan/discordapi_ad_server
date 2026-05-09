import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import type {
  ApplicationCommandInteractionPayload,
  MessageComponentInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { fetchFormatRules } from '../../validation/rules.ts';
import { ephemeral } from '../responses.ts';

export type AdRulesDeps = {
  client: PgClient;
};

export async function runAdRules(c: Context, slot: string, deps: AdRulesDeps): Promise<Response> {
  const rules = await fetchFormatRules(deps.client, slot);
  if (!rules) return ephemeral(c, `slot \`${slot}\` のルールは未設定です`);
  const content =
    `📐 **入稿ルール (slot: ${slot})**\n` +
    `MIME: ${rules.allowedMimes.join(', ')}\n` +
    `拡張子: ${rules.allowedExtensions.join(', ')}\n` +
    `最大サイズ: ${(rules.maxBytes / 1024 / 1024).toFixed(1)} MB\n` +
    `推奨アスペクト比: ${rules.aspectRatios?.join(' / ') ?? 'なし'}\n` +
    `タイトル: 最大 ${rules.titleMaxLen} 文字\n` +
    `本文: 最大 ${rules.bodyMaxLen} 文字\n` +
    `リンク URL: 最大 ${rules.linkUrlMaxLen} 文字、スキーム ${rules.linkScheme.join(' / ')}`;
  return ephemeral(c, content);
}

export async function handleAdRules(
  c: Context<{ Bindings: Bindings }>,
  _payload: ApplicationCommandInteractionPayload | MessageComponentInteractionPayload,
): Promise<Response> {
  return withPgClient(c.env.POSTGRES_URL, (client) => runAdRules(c, 'default', { client }));
}
