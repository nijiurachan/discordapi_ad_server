import type { PgClient } from '../db/client.ts';

export type UnackedFallback = {
  id: string;
  channelId: string;
  createdAt: Date;
};

export type FallbackBlock =
  | { ok: true }
  | { ok: false; channels: UnackedFallback[]; message: string };

export async function blockIfUnackedFallback(
  client: PgClient,
  sponsorId: string,
): Promise<FallbackBlock> {
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

  const channels: UnackedFallback[] = res.rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    createdAt: r.created_at,
  }));
  const mentions = channels.map((c) => `<#${c.channelId}>`).join('\n');
  return {
    ok: false,
    channels,
    message: `🚫 未確認の審査結果通知があります。
先に下記チャンネルで「✅ 了解」ボタンを押してから再起稿してください:
${mentions}`,
  };
}
