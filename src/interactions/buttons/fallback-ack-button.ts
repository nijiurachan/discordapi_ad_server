import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { findFallbackById, markFallbackAcknowledged } from '../../db/queries/fallback.ts';
import { type DiscordRest, DiscordRestError, createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { setDmDeliveryStatus } from '../../services/review/dm.ts';
import { ephemeral } from '../responses.ts';

export type AckButtonDeps = {
  rest: DiscordRest;
  client: PgClient;
};

/**
 * Core handler for `ack:{fallbackId}` button clicks. Marks the fallback as
 * acknowledged, transitions ads.dm_delivery_status='fallback_acknowledged',
 * and best-effort deletes the private channel (404 is OK — channel may have
 * been swept by P7 cron already).
 */
export async function runAckButton(
  c: Context,
  payload: MessageComponentInteractionPayload,
  deps: AckButtonDeps,
): Promise<Response> {
  const parts = payload.data.custom_id.split(':');
  const fallbackId = parts[1] ?? '';
  if (!fallbackId) return ephemeral(c, '不正なボタンです。');

  const userId = payload.member?.user.id ?? payload.user?.id ?? '';
  if (!userId) return ephemeral(c, 'ユーザー情報を取得できませんでした。');

  const row = await findFallbackById(deps.client, fallbackId);
  if (!row) {
    return ephemeral(c, 'フォールバック情報が見つかりません。既に処理済みの可能性があります。');
  }
  if (row.acknowledgedAt) return ephemeral(c, '既に確認済みです。');

  // Defense in depth: even though only the sponsor should see the channel,
  // verify the clicker matches the sponsor.
  if (row.sponsorId !== userId) {
    return ephemeral(c, 'このボタンを押せるのは対象のスポンサーのみです。');
  }

  // Atomic: ack mark + dm_delivery_status transition. If either fails, the
  // sponsor can re-click 了解 and the row stays in its previous state.
  await deps.client.query('BEGIN');
  try {
    await markFallbackAcknowledged(deps.client, fallbackId);
    await setDmDeliveryStatus(deps.client, row.adId, 'fallback_acknowledged');
    await deps.client.query('COMMIT');
  } catch (err) {
    try {
      await deps.client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Best-effort channel delete (after COMMIT — orphan deletion shouldn't roll
  // back the ack)
  try {
    await deps.rest.deleteChannel(row.channelId);
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 404) {
      console.warn('fallback ack: channel already deleted', { channelId: row.channelId });
    } else {
      console.error('fallback ack: deleteChannel failed', { channelId: row.channelId, err });
    }
  }

  return ephemeral(c, '✅ 了解を記録しました。チャンネルは削除されます。');
}

/**
 * Production entry point. Builds REST client + pg pool from env and delegates
 * to `runAckButton`.
 */
export async function handleAckButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  return withPgClient(env.POSTGRES_URL, (client) => runAckButton(c, payload, { rest, client }));
}
