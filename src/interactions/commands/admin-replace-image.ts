import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { getAdEditable, updateAdImage } from '../../db/queries/ad-edits.ts';
import { writeAdminLog } from '../../db/queries/admin-logs.ts';
import { isAdmin } from '../../discord/admin-auth.ts';
import type {
  ApplicationCommandInteractionPayload,
  Attachment,
  CommandOption,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { copyObject, createS3Client, putObject } from '../../storage/s3.ts';
import { type DetectedMime, validateImage, validateMagicBytes } from '../../validation/image.ts';
import { fetchFormatRules } from '../../validation/rules.ts';
import { ephemeral } from '../responses.ts';

const MIME_EXT: Record<DetectedMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const FETCH_TIMEOUT_MS = 5000;

export type AdminReplaceImageDeps = {
  client: PgClient;
  s3: S3Client;
  bucket: string;
  adminRoleId: string;
  fetchImpl?: typeof fetch;
  uuid?: () => string;
};

function findSubcommand(
  opts: CommandOption[] | undefined,
  name: string,
): CommandOption | undefined {
  return opts?.find((o) => o.name === name && (o.type === 1 || o.type === 2));
}
function findOption(opts: CommandOption[] | undefined, name: string): CommandOption | undefined {
  return opts?.find((o) => o.name === name);
}

export async function runAdminReplaceImage(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
  deps: AdminReplaceImageDeps,
): Promise<Response> {
  if (!isAdmin(payload, deps.adminRoleId)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const sub = findSubcommand(payload.data.options, 'replace-image');
  if (!sub) return ephemeral(c, '不明なサブコマンドです');
  const adIdOpt = findOption(sub.options, 'ad_id');
  const imageOpt = findOption(sub.options, 'image');
  const adId = typeof adIdOpt?.value === 'string' ? adIdOpt.value.trim() : '';
  const imageId = typeof imageOpt?.value === 'string' ? imageOpt.value : '';
  if (!adId || !imageId) return ephemeral(c, 'ad_id と image は必須です');

  const attachment: Attachment | undefined = payload.data.resolved?.attachments?.[imageId];
  if (!attachment) return ephemeral(c, '添付画像が見つかりませんでした');

  const ad = await getAdEditable(deps.client, adId);
  if (!ad) return ephemeral(c, `広告 \`${adId}\` が見つかりません。`);

  const rules = await fetchFormatRules(deps.client, ad.slot);
  if (!rules) return ephemeral(c, '指定 slot の入稿ルールが未設定です');
  const imgResult = validateImage(rules, attachment);
  if (!imgResult.ok) return ephemeral(c, imgResult.errors.join('\n'));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let bodyBytes: Uint8Array;
  try {
    const res = await (deps.fetchImpl ?? fetch)(attachment.url, { signal: ctrl.signal });
    if (!res.ok) return ephemeral(c, '画像の取得に失敗しました');
    bodyBytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error('admin-replace-image: fetch failed', err);
    return ephemeral(c, '画像の取得に失敗しました');
  } finally {
    clearTimeout(timer);
  }
  const detected = validateMagicBytes(bodyBytes);
  const claimed = (attachment.content_type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!detected || detected !== claimed) {
    return ephemeral(c, '画像形式が改ざんされている可能性があります');
  }

  const ext = MIME_EXT[detected];
  const versionId = (deps.uuid ?? (() => crypto.randomUUID()))().slice(0, 8);
  const newKey = `ads/${adId}/v-${versionId}.${ext}`;
  try {
    await putObject(deps.s3, deps.bucket, newKey, bodyBytes, detected);
  } catch (err) {
    console.error('admin-replace-image: putObject failed', err);
    return ephemeral(c, '画像のアップロードに失敗しました');
  }

  const update = await updateAdImage(deps.client, adId, {
    imageKey: newKey,
    imageMime: detected,
    imageBytes: attachment.size,
    imageWidth: attachment.width ?? null,
    imageHeight: attachment.height ?? null,
  });
  if (!update) return ephemeral(c, `広告 \`${adId}\` が見つかりません。`);

  // Best-effort retain the previous image key (rollback can restore it). Real
  // 30-day cleanup is handled by P7 cron; here we just keep the object alive.
  if (update.previous.imageKey && update.previous.imageKey !== newKey) {
    try {
      await copyObject(
        deps.s3,
        deps.bucket,
        update.previous.imageKey,
        `retained/${adId}/${Date.now()}-${update.previous.imageKey.split('/').pop()}`,
      );
    } catch (err) {
      console.warn('admin-replace-image: retain copy failed (non-fatal)', err);
    }
  }

  const actorId = payload.member?.user?.id ?? payload.user?.id ?? 'unknown';
  await writeAdminLog(deps.client, {
    actorId,
    action: 'replace_image',
    targetKind: 'ad',
    targetId: adId,
    before: { image_key: update.previous.imageKey, image_mime: update.previous.imageMime },
    after: { image_key: newKey, image_mime: detected },
  });

  return ephemeral(c, `✅ 画像を差し替えました（${newKey}）`);
}

export async function handleAdminReplaceImage(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
): Promise<Response> {
  const s3 = createS3Client({
    endpoint: c.env.S3_ENDPOINT,
    region: c.env.S3_REGION,
    accessKeyId: c.env.S3_ACCESS_KEY_ID,
    secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
  });
  return withPgClient(c.env.POSTGRES_URL, (client) =>
    runAdminReplaceImage(c, payload, {
      client,
      s3,
      bucket: c.env.S3_BUCKET,
      adminRoleId: c.env.ADMIN_ROLE_ID,
    }),
  );
}
