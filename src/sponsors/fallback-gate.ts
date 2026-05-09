import type { PgClient } from '../db/client.ts';
import { type DiscordRest, DiscordRestError } from '../discord/rest.ts';

export type UnackedFallback = {
  id: string;
  channelId: string;
  createdAt: Date;
};

export type FallbackBlock =
  | { ok: true }
  | { ok: false; channels: UnackedFallback[]; message: string };

export type BlockIfUnackedFallbackArgs = {
  client: PgClient;
  rest: DiscordRest;
  sponsorId: string;
};

async function autoCloseFallback(client: PgClient, fallbackId: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      'UPDATE dm_fallback_channels SET acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL',
      [fallbackId],
    );
    await client.query(
      `UPDATE ads
          SET dm_delivery_status = 'fallback_acknowledged'
        WHERE id = (SELECT ad_id FROM dm_fallback_channels WHERE id = $1)`,
      [fallbackId],
    );
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function blockIfUnackedFallback(
  args: BlockIfUnackedFallbackArgs,
): Promise<FallbackBlock> {
  const { client, rest, sponsorId } = args;
  const res = await client.query<{
    id: string;
    channel_id: string;
    created_at: Date;
  }>(
    `SELECT id, channel_id, created_at
       FROM dm_fallback_channels
      WHERE sponsor_id = $1
        AND acknowledged_at IS NULL
        AND expires_at > now()
      ORDER BY created_at ASC`,
    [sponsorId],
  );

  if (res.rows.length === 0) return { ok: true };

  const surviving: UnackedFallback[] = [];
  for (const r of res.rows) {
    try {
      await rest.getChannel(r.channel_id);
      surviving.push({ id: r.id, channelId: r.channel_id, createdAt: r.created_at });
    } catch (err) {
      if (err instanceof DiscordRestError && err.status === 404) {
        // Channel no longer exists in Discord — auto-close the orphaned fallback row
        // so future submissions aren't perpetually blocked.
        try {
          await autoCloseFallback(client, r.id);
          console.warn(
            `[fallback-gate] auto-closed orphaned fallback row id=${r.id} channel_id=${r.channel_id} sponsor_id=${sponsorId}`,
          );
        } catch (closeErr) {
          console.warn(
            `[fallback-gate] auto-close failed for fallback id=${r.id} channel_id=${r.channel_id}: ${
              closeErr instanceof Error ? closeErr.message : String(closeErr)
            }`,
          );
          // If auto-close itself failed, still treat as a block to be safe.
          surviving.push({ id: r.id, channelId: r.channel_id, createdAt: r.created_at });
        }
      } else {
        // Non-404 errors (transient outages, unknown errors) — keep the row in the
        // block list to avoid silently clearing during Discord problems.
        surviving.push({ id: r.id, channelId: r.channel_id, createdAt: r.created_at });
      }
    }
  }

  if (surviving.length === 0) return { ok: true };

  const mentions = surviving.map((c) => `<#${c.channelId}>`).join('\n');
  return {
    ok: false,
    channels: surviving,
    message: `🚫 未確認の審査結果通知があります。
先に下記チャンネルで「✅ 了解」ボタンを押してから再起稿してください:
${mentions}`,
  };
}
