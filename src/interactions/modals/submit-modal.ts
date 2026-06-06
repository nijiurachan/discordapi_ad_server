import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { setAdReviewMessageId } from '../../db/queries/review.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import { postReviewEmbed } from '../../discord/review-embed.ts';
import type { ModalSubmitInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { buildPublicImageUrl } from '../../serve/router.ts';
import { countActiveAds } from '../../sponsors/tier.ts';
import {
  BANNER_OUTPUT_EXT,
  BANNER_OUTPUT_MIME,
  BANNER_HEIGHT,
  BANNER_WIDTH,
  resizeBanner,
} from '../../utils/image-resize.ts';
import { createS3Client, deleteObject, getObject, putObject } from '../../storage/s3.ts';
import { fetchFormatRules } from '../../validation/rules.ts';
import { validateBody, validateLinkUrl, validateTitle } from '../../validation/text.ts';
import { ephemeral } from '../responses.ts';

export type ModalSubmitDeps = {
  rest: DiscordRest;
  client: PgClient;
  s3: S3Client;
  bucket: string;
  reviewChannelId: string;
  s3PublicBaseUrl: string;
  uuid: () => string;
};

type AdDraft = {
  id: string;
  sponsorId: string;
  slot: string;
  imageKey: string;
  imageMime: string;
  imageBytes: number;
  imageWidth: number | null;
  imageHeight: number | null;
  expiresAt: Date;
};

async function fetchDraft(client: PgClient, draftId: string): Promise<AdDraft | null> {
  const res = await client.query<{
    id: string;
    sponsor_id: string;
    slot: string;
    image_key: string;
    image_mime: string;
    image_bytes: number;
    image_width: number | null;
    image_height: number | null;
    expires_at: Date;
  }>(
    `SELECT id, sponsor_id, slot, image_key, image_mime, image_bytes,
            image_width, image_height, expires_at
       FROM ad_drafts
      WHERE id = ?`,
    [draftId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sponsorId: row.sponsor_id,
    slot: row.slot,
    imageKey: row.image_key,
    imageMime: row.image_mime,
    imageBytes: row.image_bytes,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    expiresAt:
      row.expires_at instanceof Date
        ? row.expires_at
        : new Date(row.expires_at as unknown as string),
  };
}

function findTextValue(payload: ModalSubmitInteractionPayload, customId: string): string {
  for (const row of payload.data.components) {
    for (const comp of row.components) {
      if (comp.custom_id === customId) return comp.value;
    }
  }
  return '';
}

async function fetchTierLimit(client: PgClient, sponsorId: string): Promise<number | null> {
  const res = await client.query<{ max_active_ads: number }>(
    `SELECT t.max_active_ads
       FROM sponsors s
       JOIN tiers t ON t.id = s.current_tier_id
      WHERE s.discord_user_id = ?`,
    [sponsorId],
  );
  return res.rows[0]?.max_active_ads ?? null;
}

/**
 * Core handler for `submit:{draft_id}` modal submissions. Tests inject all
 * deps; production wraps this with `withPgClient` + real REST/S3 in
 * `handleSubmitModal`.
 */
export async function runSubmitModal(
  c: Context,
  payload: ModalSubmitInteractionPayload,
  deps: ModalSubmitDeps,
): Promise<Response> {
  // 1. extract draft_id from custom_id
  const customId = payload.data.custom_id;
  if (!customId.startsWith('submit:')) {
    return ephemeral(c, '不正な custom_id です');
  }
  const draftId = customId.slice('submit:'.length);

  // 2. fetch draft + check expiry
  const draft = await fetchDraft(deps.client, draftId);
  if (!draft) {
    return ephemeral(
      c,
      '下書きが見つかりません。期限切れの可能性があります。再度起稿してください。',
    );
  }
  if (draft.expiresAt.getTime() < Date.now()) {
    return ephemeral(c, '下書きの有効期限が切れています。再度起稿してください。');
  }

  // 3. extract Modal text
  const title = findTextValue(payload, 'title');
  const body = findTextValue(payload, 'body');
  const linkUrl = findTextValue(payload, 'link_url');

  // 4. fetch rules + validate text
  const rules = await fetchFormatRules(deps.client, draft.slot);
  if (!rules) {
    return ephemeral(c, '指定された slot の入稿ルールが未設定です');
  }
  const titleResult = validateTitle(rules, title);
  if (!titleResult.ok) return ephemeral(c, titleResult.error);
  const bodyResult = validateBody(rules, body);
  if (!bodyResult.ok) return ephemeral(c, bodyResult.error);
  const linkResult = validateLinkUrl(rules, linkUrl);
  if (!linkResult.ok) return ephemeral(c, linkResult.error);

  // 5. generate ad_id + compute keys (kept outside tx so we can clean up on failure).
  const adId = deps.uuid();
  const stagingKey = draft.imageKey;
  // Output is always PNG since we re-encode after the photon resize; the
  // final key extension follows that, not the input MIME.
  const finalKey = `ads/${adId}/orig.${BANNER_OUTPUT_EXT}`;

  // 6. Fetch staging bytes, resize to the fixed 468×60 banner box, PUT the
  // resized output to the final key. Replaces the previous direct copy so
  // every approved ad ships at the same display size regardless of upload
  // resolution — the integrator pins width="468" height="60" and never sees
  // layout shift between sponsors. (Runs BEFORE the transaction so we don't
  // hold the DB row through CPU-bound WASM work.)
  let resizedBytes: Uint8Array;
  try {
    const src = await getObject(deps.s3, deps.bucket, stagingKey);
    if (!src) {
      console.error('submit-modal: staging missing', { stagingKey, adId });
      return ephemeral(c, '下書き画像が見つかりません。再度起稿してください。');
    }
    const rawBytes = new Uint8Array(await new Response(src.body).arrayBuffer());
    resizedBytes = resizeBanner(rawBytes).bytes;
    await putObject(deps.s3, deps.bucket, finalKey, resizedBytes, BANNER_OUTPUT_MIME);
  } catch (err) {
    console.error('submit-modal: resize/save failed', { stagingKey, finalKey, adId, err });
    return ephemeral(c, '画像の本格保存に失敗しました。再度起稿してください。');
  }

  // 7. atomic block: lock draft row, recheck tier, INSERT ads, DELETE draft.
  // SELECT ... on the draft row serializes concurrent modal
  // submissions of the same draft. (Multi-draft per sponsor races remain
  // a known limitation; see follow-up.)
  let txOpen = false;
  try {
    await deps.client.query('BEGIN');
    txOpen = true;

    const lockRes = await deps.client.query<{ id: string }>(
      'SELECT id FROM ad_drafts WHERE id = ?',
      [draftId],
    );
    if (lockRes.rows.length === 0) {
      await deps.client.query('ROLLBACK');
      txOpen = false;
      try {
        await deleteObject(deps.s3, deps.bucket, finalKey);
      } catch (cleanupErr) {
        console.error('submit-modal: rollback cleanup failed', { finalKey, cleanupErr });
      }
      return ephemeral(c, '下書きが既に処理済みです。再度起稿してください。');
    }

    // Recheck tier limit inside the locked transaction.
    const tierLimit = await fetchTierLimit(deps.client, draft.sponsorId);
    if (tierLimit !== null) {
      const activeCount = await countActiveAds(deps.client, draft.sponsorId);
      if (activeCount >= tierLimit) {
        await deps.client.query('ROLLBACK');
        txOpen = false;
        try {
          await deleteObject(deps.s3, deps.bucket, finalKey);
        } catch (cleanupErr) {
          console.error('submit-modal: over-limit cleanup failed', { finalKey, cleanupErr });
        }
        return ephemeral(
          c,
          `現在のティアでは同時に最大 ${tierLimit} 件まで配信できます。（既に ${activeCount} 件あります）`,
        );
      }
    }

    await deps.client.query(
      `INSERT INTO ads
         (id, sponsor_id, kind, slot, title, body, link_url,
          image_key, image_mime, image_bytes, image_width, image_height, status)
       VALUES (?, ?, 'regular', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        adId,
        draft.sponsorId,
        draft.slot,
        title,
        body,
        linkUrl,
        finalKey,
        BANNER_OUTPUT_MIME,
        resizedBytes.byteLength,
        BANNER_WIDTH,
        BANNER_HEIGHT,
      ],
    );

    await deps.client.query('DELETE FROM ad_drafts WHERE id = ?', [draftId]);

    await deps.client.query('COMMIT');
    txOpen = false;
  } catch (err) {
    console.error('submit-modal: transaction failed', { adId, finalKey, draftId, err });
    if (txOpen) {
      try {
        await deps.client.query('ROLLBACK');
      } catch (rbErr) {
        console.error('submit-modal: ROLLBACK failed', rbErr);
      }
    }
    try {
      await deleteObject(deps.s3, deps.bucket, finalKey);
    } catch (cleanupErr) {
      console.error('submit-modal: tx cleanup deleteObject failed', { finalKey, cleanupErr });
    }
    return ephemeral(c, '広告の登録に失敗しました。再度起稿してください。');
  }

  // 8. best-effort: delete staging object (cron sweeps stragglers if this fails)
  try {
    await deleteObject(deps.s3, deps.bucket, stagingKey);
  } catch (err) {
    console.error('submit-modal: staging delete failed (cron will sweep)', err);
  }

  // 9. post review embed (non-fatal: admin can re-trigger if it fails)
  try {
    const imageUrl = buildPublicImageUrl(deps.s3PublicBaseUrl, finalKey);
    const result = await postReviewEmbed({
      rest: deps.rest,
      channelId: deps.reviewChannelId,
      ad: { id: adId, slot: draft.slot, title, body, linkUrl, imageUrl },
      sponsor: { id: draft.sponsorId },
    });
    // Persist message_id so P3.2 / P3.3 can edit the same review message.
    try {
      await setAdReviewMessageId(deps.client, adId, result.messageId);
    } catch (persistErr) {
      console.error('submit-modal: setAdReviewMessageId failed', persistErr);
    }
  } catch (err) {
    console.error('submit-modal: review embed post failed', err);
    // continue; admin can re-trigger
  }

  // 10. ephemeral confirmation (DM notifications arrive in P3; for now we just
  // confirm receipt without making a promise about delivery channel).
  return ephemeral(c, '✅ 受付完了 — 審査結果が出ましたらお知らせします。');
}

/**
 * Production entry point: builds REST/S3 clients from env, opens a pg pool
 * scoped to the request, and delegates to `runSubmitModal`.
 */
export async function handleSubmitModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  const s3 = createS3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  return withPgClient(env, (client) =>
    runSubmitModal(c, payload, {
      rest,
      client,
      s3,
      bucket: env.S3_BUCKET,
      reviewChannelId: env.REVIEW_CHANNEL_ID,
      s3PublicBaseUrl: env.S3_PUBLIC_BASE_URL,
      uuid: () => crypto.randomUUID(),
    }),
  );
}
