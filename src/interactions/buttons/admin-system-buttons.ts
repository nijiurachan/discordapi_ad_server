import type { Context } from 'hono';
import { withPgClient } from '../../db/client.ts';
import { AdminButtonIds } from '../../discord/admin-menu.ts';
import { createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { repostAdminMenu, rotateSalt, runHealthCheck } from '../../services/admin/system-utils.ts';
import { createS3Client } from '../../storage/s3.ts';
import { ephemeral } from '../responses.ts';

export async function handleAdminSystemButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
  buttonId: string,
): Promise<Response> {
  const actorId = payload.member?.user?.id ?? payload.user?.id ?? 'unknown';

  if (buttonId === AdminButtonIds.SYSTEM_REPOST) {
    const rest = createDiscordRest({ token: c.env.DISCORD_BOT_TOKEN });
    const result = await withPgClient(c.env.POSTGRES_URL, (client) =>
      repostAdminMenu(client, rest, actorId),
    );
    if (result.reposted.length === 0) {
      return ephemeral(
        c,
        '⚠ 管理メニューのチャンネルが未設定です。先に `/ad-setup channel:<chan> kind:admin` を実行してください。',
      );
    }
    const top = result.reposted[0];
    return ephemeral(
      c,
      top
        ? `✅ 管理メニューを再投稿しました（<#${top.channelId}> id=\`${top.messageId.slice(0, 12)}\`）`
        : '✅ 管理メニューを再投稿しました',
    );
  }

  if (buttonId === AdminButtonIds.SYSTEM_ROTATE_SALT) {
    const result = await withPgClient(c.env.POSTGRES_URL, (client) => rotateSalt(client, actorId));
    return ephemeral(
      c,
      `🔁 ip_hash_salt を即時ローテーションしました（length=${result.newSaltLength}）。新しいインプレッション/クリックは新ソルトで集計されます。`,
    );
  }

  if (buttonId === AdminButtonIds.SYSTEM_HEALTH) {
    const s3 = createS3Client({
      endpoint: c.env.S3_ENDPOINT,
      region: c.env.S3_REGION,
      accessKeyId: c.env.S3_ACCESS_KEY_ID,
      secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
    });
    const result = await withPgClient(c.env.POSTGRES_URL, (client) =>
      runHealthCheck(client, s3, c.env.S3_BUCKET),
    );
    const overall = result.db === 'ok' && result.s3 === 'ok' ? '✅ 全系統 OK' : '⚠ 一部劣化';
    return ephemeral(c, `${overall}\n• db: ${result.db}\n• s3: ${result.s3}`);
  }

  return ephemeral(c, '未対応のシステム操作です。');
}
