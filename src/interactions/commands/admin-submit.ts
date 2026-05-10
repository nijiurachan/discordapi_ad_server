import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { isAdmin } from '../../discord/admin-auth.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type {
  ApplicationCommandInteractionPayload,
  Attachment,
  CommandOption,
  ModalResponse,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { createS3Client, deleteObject, putObject } from '../../storage/s3.ts';
import { type DetectedMime, validateImage, validateMagicBytes } from '../../validation/image.ts';
import { fetchFormatRules } from '../../validation/rules.ts';
import { ephemeral, modalResponse } from '../responses.ts';

const MIME_EXT: Record<DetectedMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const IMAGE_FETCH_TIMEOUT_MS = 5000;

export type AdminSubmitDeps = {
  client: PgClient;
  rest: DiscordRest;
  s3: S3Client;
  bucket: string;
  adminRoleId: string;
  fetchImpl?: typeof fetch;
  uuid?: () => string;
};

function findSubcommand(
  options: CommandOption[] | undefined,
  name: string,
): CommandOption | undefined {
  return options?.find((o) => o.name === name && (o.type === 1 || o.type === 2));
}

function findOption(options: CommandOption[] | undefined, name: string): CommandOption | undefined {
  return options?.find((o) => o.name === name);
}

function asString(o: CommandOption | undefined): string | undefined {
  return typeof o?.value === 'string' ? o.value : undefined;
}

function asNumber(o: CommandOption | undefined): number | undefined {
  return typeof o?.value === 'number' ? o.value : undefined;
}

function asBoolean(o: CommandOption | undefined): boolean | undefined {
  return typeof o?.value === 'boolean' ? o.value : undefined;
}

export async function runAdminSubmit(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
  deps: AdminSubmitDeps,
): Promise<Response> {
  if (!isAdmin(payload, deps.adminRoleId)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }

  const submitCmd = findSubcommand(payload.data.options, 'submit');
  if (!submitCmd) {
    return ephemeral(c, '不明なサブコマンドです');
  }

  const kind = asString(findOption(submitCmd.options, 'kind'));
  const slot = asString(findOption(submitCmd.options, 'slot'));
  const imageId = asString(findOption(submitCmd.options, 'image'));
  const weight = asNumber(findOption(submitCmd.options, 'weight'));
  const sponsorIdOpt = asString(findOption(submitCmd.options, 'sponsor_id'));
  const autoApprove = asBoolean(findOption(submitCmd.options, 'auto_approve')) ?? false;
  const endsInDays = asNumber(findOption(submitCmd.options, 'ends_in_days'));

  if (!kind || !slot || !imageId) {
    return ephemeral(c, '必須引数が不足しています（kind, slot, image）');
  }
  if (kind !== 'regular' && kind !== 'house' && kind !== 'placeholder') {
    return ephemeral(c, 'kind は regular/house/placeholder のいずれかを指定してください');
  }
  if (kind !== 'regular' && sponsorIdOpt) {
    return ephemeral(
      c,
      `sponsor_id は kind=regular の場合のみ指定可能です（指定された kind=${kind}）`,
    );
  }

  const attachment: Attachment | undefined = payload.data.resolved?.attachments?.[imageId];
  if (!attachment) {
    return ephemeral(c, '添付画像が見つかりませんでした');
  }

  const actorId = payload.member?.user?.id ?? payload.user?.id;
  const actorName = payload.member?.user?.username ?? payload.user?.username ?? actorId ?? 'admin';
  if (!actorId) {
    return ephemeral(c, 'ユーザー情報を特定できませんでした');
  }

  const rules = await fetchFormatRules(deps.client, slot);
  if (!rules) {
    return ephemeral(c, '指定された slot の入稿ルールが未設定です');
  }
  const imgResult = validateImage(rules, attachment);
  if (!imgResult.ok) {
    return ephemeral(c, imgResult.errors.join('\n'));
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let bodyBytes: Uint8Array;
  try {
    const res = await (deps.fetchImpl ?? fetch)(attachment.url, { signal: ctrl.signal });
    if (!res.ok) {
      return ephemeral(c, '画像の取得に失敗しました');
    }
    bodyBytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error('admin-submit: image fetch failed', err);
    return ephemeral(c, '画像の取得に失敗しました');
  } finally {
    clearTimeout(timer);
  }
  const detected = validateMagicBytes(bodyBytes);
  const claimedMime = (attachment.content_type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!detected || detected !== claimedMime) {
    return ephemeral(c, '画像形式が改ざんされている可能性があります');
  }

  // For kind=regular: ensure the sponsor row exists. Use sponsor_id option or actor as sponsor.
  const sponsorIdForDraft = kind === 'regular' ? (sponsorIdOpt ?? actorId) : null;
  if (kind === 'regular') {
    await deps.client.query(
      `INSERT INTO sponsors (discord_user_id, display_name)
         VALUES ($1, $2)
       ON CONFLICT (discord_user_id) DO NOTHING`,
      [sponsorIdForDraft, actorName],
    );
  }

  const draftId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const ext = MIME_EXT[detected];
  const imageKey = `staging/${draftId}/orig.${ext}`;
  try {
    await putObject(deps.s3, deps.bucket, imageKey, bodyBytes, detected);
  } catch (err) {
    console.error('admin-submit: S3 putObject failed', err);
    return ephemeral(c, 'ステージングへの画像アップロードに失敗しました。');
  }

  try {
    await deps.client.query(
      `INSERT INTO ad_drafts
         (id, sponsor_id, slot, image_key, image_mime, image_bytes,
          image_width, image_height, kind, weight, auto_approve,
          ends_in_days, created_by_admin, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         now() + interval '10 minutes')`,
      [
        draftId,
        sponsorIdForDraft,
        slot,
        imageKey,
        detected,
        attachment.size,
        attachment.width ?? null,
        attachment.height ?? null,
        kind,
        weight ?? null,
        autoApprove,
        endsInDays ?? null,
        actorId,
      ],
    );
  } catch (err) {
    console.error('admin-submit: ad_drafts INSERT failed', err);
    try {
      await deleteObject(deps.s3, deps.bucket, imageKey);
    } catch (cleanupErr) {
      console.error('admin-submit: cleanup failed', cleanupErr);
    }
    return ephemeral(c, '下書きの保存に失敗しました。再度お試しください。');
  }

  const modal: ModalResponse = {
    custom_id: `admin-submit:${draftId}`,
    title: '広告内容の入力（管理者）',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'title',
            label: 'タイトル',
            style: 1,
            required: true,
            min_length: 1,
            max_length: rules.titleMaxLen,
            placeholder: '広告のタイトル',
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'body',
            label: '本文',
            style: 2,
            required: true,
            min_length: 1,
            max_length: rules.bodyMaxLen,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'link_url',
            label: 'リンク URL',
            style: 1,
            required: true,
            min_length: 8,
            max_length: rules.linkUrlMaxLen,
            placeholder: 'https://example.com',
          },
        ],
      },
    ],
  };
  return modalResponse(c, modal);
}

export async function handleAdminSubmit(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
): Promise<Response> {
  const rest = createDiscordRest({ token: c.env.DISCORD_BOT_TOKEN });
  const s3 = createS3Client({
    endpoint: c.env.S3_ENDPOINT,
    region: c.env.S3_REGION,
    accessKeyId: c.env.S3_ACCESS_KEY_ID,
    secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
  });
  return withPgClient(c.env.POSTGRES_URL, (client) =>
    runAdminSubmit(c, payload, {
      client,
      rest,
      s3,
      bucket: c.env.S3_BUCKET,
      adminRoleId: c.env.ADMIN_ROLE_ID,
    }),
  );
}
