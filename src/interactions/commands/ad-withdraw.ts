import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { withdrawAd } from '../../db/queries/ads.ts';
import type {
  ApplicationCommandInteractionPayload,
  MessageComponentInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { ephemeral } from '../responses.ts';

export type AdWithdrawDeps = {
  client: PgClient;
};

const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function runAdWithdraw(
  c: Context,
  userId: string,
  adId: string,
  deps: AdWithdrawDeps,
): Promise<Response> {
  if (!adId || !UUID_RE.test(adId)) {
    return ephemeral(c, '広告 ID の形式が不正です');
  }
  const result = await withdrawAd(deps.client, userId, adId);
  if (!result.ok) {
    const message =
      result.reason === 'not_found'
        ? '広告が見つかりません'
        : result.reason === 'not_owner'
          ? 'この広告の取り下げ権限がありません'
          : '現在のステータスでは取り下げできません（既に取り下げ済み・期限切れ・却下済み等）';
    return ephemeral(c, message);
  }
  return ephemeral(c, '✅ 広告を取り下げました。');
}

export async function handleAdWithdrawCommand(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
): Promise<Response> {
  const userId = payload.member?.user.id ?? payload.user?.id;
  if (!userId) return ephemeral(c, 'ユーザー情報を取得できませんでした');
  const sub = payload.data.options?.find((o) => o.name === 'withdraw');
  const idOpt = sub?.options?.find((o) => o.name === 'id');
  const adId = typeof idOpt?.value === 'string' ? idOpt.value : '';
  return withPgClient(c.env.POSTGRES_URL, (client) => runAdWithdraw(c, userId, adId, { client }));
}

export async function handleAdWithdrawButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  const userId = payload.member?.user.id ?? payload.user?.id;
  if (!userId) return ephemeral(c, 'ユーザー情報を取得できませんでした');
  // custom_id format: ad:withdraw:{adId}
  const parts = payload.data.custom_id.split(':');
  const adId = parts[2] ?? '';
  return withPgClient(c.env.POSTGRES_URL, (client) => runAdWithdraw(c, userId, adId, { client }));
}
