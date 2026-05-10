import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { PgClient } from '../../db/client.ts';
import { writeAdminLog } from '../../db/queries/admin-logs.ts';
import { SystemSettingKey, getSystemSetting, setSystemSetting } from '../../db/settings.ts';
import { buildAdminMenuMessage } from '../../discord/admin-menu.ts';
import type { DiscordRest } from '../../discord/rest.ts';

export type RepostMenusResult = {
  reposted: Array<{ kind: 'admin'; channelId: string; messageId: string }>;
};

export async function repostAdminMenu(
  client: PgClient,
  rest: DiscordRest,
  actorId: string,
): Promise<RepostMenusResult> {
  const channelId = await getSystemSetting<string>(client, SystemSettingKey.ADMIN_MENU_CHANNEL_ID);
  if (!channelId) return { reposted: [] };

  const oldMessageId = await getSystemSetting<string>(
    client,
    SystemSettingKey.ADMIN_MENU_MESSAGE_ID,
  );
  if (oldMessageId) {
    try {
      await rest.deleteMessage(channelId, oldMessageId);
    } catch (err) {
      console.warn('system: old admin menu delete failed (likely gone)', err);
    }
  }
  const message = await rest.createMessage(channelId, buildAdminMenuMessage());
  await setSystemSetting(client, SystemSettingKey.ADMIN_MENU_MESSAGE_ID, message.id, actorId);
  await writeAdminLog(client, {
    actorId,
    action: 'menu_repost',
    targetKind: 'menu',
    targetId: 'admin',
    after: { channel_id: channelId, message_id: message.id },
  });
  return { reposted: [{ kind: 'admin', channelId, messageId: message.id }] };
}

export type RotateSaltResult = {
  newSaltLength: number;
};

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function rotateSalt(client: PgClient, actorId: string): Promise<RotateSaltResult> {
  const newSalt = randomHex(32);
  await setSystemSetting(client, 'ip_hash_salt', { salt: newSalt }, actorId);
  await writeAdminLog(client, {
    actorId,
    action: 'rotate_salt',
    targetKind: 'system',
    targetId: 'ip_hash_salt',
  });
  return { newSaltLength: newSalt.length };
}

export type HealthCheckResult = {
  db: 'ok' | 'unavailable';
  s3: 'ok' | 'unavailable';
};

const PROBE_TIMEOUT_MS = 2000;

export async function runHealthCheck(
  client: PgClient,
  s3: S3Client,
  bucket: string,
): Promise<HealthCheckResult> {
  let db: HealthCheckResult['db'] = 'unavailable';
  try {
    await client.query('SELECT 1');
    db = 'ok';
  } catch (err) {
    console.error('admin health: db probe failed', err);
  }
  let s3Status: HealthCheckResult['s3'] = 'unavailable';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: ctrl.signal });
    s3Status = 'ok';
  } catch (err) {
    console.error('admin health: s3 probe failed', err);
  } finally {
    clearTimeout(timer);
  }
  return { db, s3: s3Status };
}
