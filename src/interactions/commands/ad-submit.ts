import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type {
  ApplicationCommandInteractionPayload,
  Attachment,
  CommandOption,
  ModalResponse,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { blockIfUnackedFallback } from '../../sponsors/fallback-gate.ts';
import {
  type Tier,
  checkMaxActiveAds,
  countActiveAds,
  refreshSponsorTier,
} from '../../sponsors/tier.ts';
import { createS3Client, putObject } from '../../storage/s3.ts';
import { type DetectedMime, validateImage, validateMagicBytes } from '../../validation/image.ts';
import { type FormatRules, fetchFormatRules } from '../../validation/rules.ts';
import { ephemeral, modalResponse } from '../responses.ts';

// MIME -> extension mapping for staging keys.
const MIME_EXT: Record<DetectedMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export type AdSubmitDeps = {
  client: PgClient;
  rest: DiscordRest;
  s3: S3Client;
  bucket: string;
  guildId: string;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
  // Injectable for tests; defaults to crypto.randomUUID.
  uuid?: () => string;
};

/**
 * Find subcommand named `name` within `payload.data.options`.
 * `/ad submit` is sent as a top-level command "ad" with a subcommand option "submit".
 */
function findSubcommand(
  options: CommandOption[] | undefined,
  name: string,
): CommandOption | undefined {
  if (!options) return undefined;
  return options.find((o) => o.name === name && (o.type === 1 || o.type === 2));
}

function findOption(options: CommandOption[] | undefined, name: string): CommandOption | undefined {
  if (!options) return undefined;
  return options.find((o) => o.name === name);
}

/**
 * Core of `/ad submit`. Tests inject all dependencies; production wraps this
 * with `withPgClient` and real REST/S3 clients in `handleAdSubmit`.
 */
export async function runAdSubmit(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
  deps: AdSubmitDeps,
): Promise<Response> {
  const { client, rest, s3, bucket, guildId } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());

  // 1. Extract slot + attachment id from the submit subcommand options.
  const submitCmd = findSubcommand(payload.data.options, 'submit');
  const slotOpt = findOption(submitCmd?.options, 'slot');
  const imageOpt = findOption(submitCmd?.options, 'image');
  const slot = typeof slotOpt?.value === 'string' ? slotOpt.value : undefined;
  const imageId = typeof imageOpt?.value === 'string' ? imageOpt.value : undefined;
  if (!slot || !imageId) {
    return ephemeral(c, 'コマンドの引数が不足しています');
  }
  const attachment: Attachment | undefined = payload.data.resolved?.attachments?.[imageId];
  if (!attachment) {
    return ephemeral(c, '添付画像が見つかりませんでした');
  }

  // 2. Identify sponsor.
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const username = payload.member?.user?.username ?? payload.user?.username ?? userId ?? 'unknown';
  if (!userId) {
    return ephemeral(c, 'ユーザー情報を特定できませんでした');
  }

  // 3. Fallback gate.
  const fb = await blockIfUnackedFallback(client, userId);
  if (!fb.ok) {
    return ephemeral(c, fb.message);
  }

  // 4. Lazy refresh tier (wrap REST call to surface a friendly error).
  let tier: Tier | null;
  try {
    tier = await refreshSponsorTier({
      rest,
      client,
      guildId,
      userId,
      displayName: username,
    });
  } catch {
    return ephemeral(c, 'ギルドメンバー情報を取得できませんでした');
  }
  if (!tier) {
    return ephemeral(c, 'ティアロールが付与されていません。サポーター登録後に再試行してください');
  }

  // 5. Active ad count + max check.
  const activeCount = await countActiveAds(client, userId);
  const maxCheck = checkMaxActiveAds(tier, activeCount);
  if (!maxCheck.ok) {
    return ephemeral(c, maxCheck.message);
  }

  // 6. Format rules.
  const rules: FormatRules | null = await fetchFormatRules(client, slot);
  if (!rules) {
    return ephemeral(c, '指定された slot の入稿ルールが未設定です');
  }

  // 7. Image metadata validation.
  const imgResult = validateImage(rules, attachment);
  if (!imgResult.ok) {
    return ephemeral(c, imgResult.errors.join('\n'));
  }

  // 8. Fetch + magic bytes.
  let bodyBytes: Uint8Array;
  try {
    const res = await fetchImpl(attachment.url);
    if (!res.ok) {
      return ephemeral(c, '画像の取得に失敗しました');
    }
    const buf = await res.arrayBuffer();
    bodyBytes = new Uint8Array(buf);
  } catch {
    return ephemeral(c, '画像の取得に失敗しました');
  }
  const detected = validateMagicBytes(bodyBytes);
  // Defensive parse: Discord usually sends a bare MIME, but content_type may
  // theoretically include parameters (e.g., "image/png; charset=utf-8"). Strip
  // any parameter and lowercase to compare against the magic-bytes verdict
  // (which is already lowercase).
  const claimedMime = (attachment.content_type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!detected || detected !== claimedMime) {
    return ephemeral(c, '画像形式が改ざんされている可能性があります');
  }

  // 9. S3 staging PUT.
  const draftId = uuid();
  const ext = MIME_EXT[detected];
  const imageKey = `staging/${draftId}/orig.${ext}`;
  try {
    await putObject(s3, bucket, imageKey, bodyBytes, detected);
  } catch (err) {
    console.error('ad-submit: S3 putObject failed', { draftId, imageKey, err });
    return ephemeral(
      c,
      'ステージングへの画像アップロードに失敗しました。しばらくしてから再度お試しください。',
    );
  }

  // 10. Insert ad_drafts row (expires in 10 minutes).
  await client.query(
    `INSERT INTO ad_drafts
       (id, sponsor_id, slot, image_key, image_mime, image_bytes,
        image_width, image_height, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '10 minutes')`,
    [
      draftId,
      userId,
      slot,
      imageKey,
      detected,
      attachment.size,
      attachment.width ?? null,
      attachment.height ?? null,
    ],
  );

  // 11. Return Modal response.
  const modal: ModalResponse = {
    custom_id: `submit:${draftId}`,
    title: '広告内容の入力',
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
            placeholder: '広告の本文',
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

/**
 * Production entry point: builds REST/S3 clients from env, opens a pg pool
 * scoped to the request, and delegates to `runAdSubmit`.
 */
export async function handleAdSubmit(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
): Promise<Response> {
  const guildId = payload.guild_id ?? c.env.GUILD_ID;
  if (!guildId) {
    return c.json({ error: 'guild_id is required' }, 400);
  }

  const rest = createDiscordRest({ token: c.env.DISCORD_BOT_TOKEN });
  const s3 = createS3Client({
    endpoint: c.env.S3_ENDPOINT,
    region: c.env.S3_REGION,
    accessKeyId: c.env.S3_ACCESS_KEY_ID,
    secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
  });

  return withPgClient(c.env.POSTGRES_URL, (client) =>
    runAdSubmit(c, payload, {
      client,
      rest,
      s3,
      bucket: c.env.S3_BUCKET,
      guildId,
    }),
  );
}
