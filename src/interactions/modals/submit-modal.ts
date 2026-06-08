import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { setAdReviewMessageId } from '../../db/queries/review.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import { postReviewEmbed } from '../../discord/review-embed.ts';
import type { ModalSubmitInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { buildPublicImageUrl } from '../../serve/router.ts';
import { copyObject, createS3Client, deleteObject } from '../../storage/s3.ts';
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
  weight: number | null;
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
    weight: number | null;
  }>(
    `SELECT id, sponsor_id, slot, image_key, image_mime, image_bytes,
            image_width, image_height, weight, expires_at
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
    weight: row.weight,
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
  const ext = draft.imageKey.split('.').pop() ?? 'bin';
  const stagingKey = draft.imageKey;
  const finalKey = `ads/${adId}/orig.${ext}`;

  // 6. S3 copy staging → ads/{ad_id}/  (BEFORE the transaction so we don't
  // hold a pg connection during S3 I/O).
  try {
    await copyObject(deps.s3, deps.bucket, stagingKey, finalKey);
  } catch (err) {
    console.error('submit-modal: S3 copyObject failed', { stagingKey, finalKey, adId, err });
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

    // The reservation: how much of the sponsor's tier budget this banner claims.
    const requested = draft.weight ?? 1;

    const insertRes = await deps.client.query(
      // D1/SQLite has no row locks, so we cannot read-then-write the budget
      // safely. This single atomic statement inserts the pending row ONLY when
      // Σ weight_alloc over the sponsor's existing pending+approved regular
      // non-admin ads, plus `requested`, is still <= the live tier weight.
      // `meta.changes` (rowCount) == 0 ⇒ over budget ⇒ nothing inserted.
      `INSERT INTO ads
         (id, sponsor_id, kind, slot, title, body, link_url,
          image_key, image_mime, image_bytes, image_width, image_height, status, weight_alloc)
       SELECT ?, ?, 'regular', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
        WHERE (
          (SELECT COALESCE(SUM(weight_alloc), 0)
             FROM ads
            WHERE sponsor_id = ?
              AND kind = 'regular'
              AND created_by_admin IS NULL
              AND status IN ('pending', 'approved')) + ?
        ) <= (SELECT t.weight
                FROM sponsors s
                JOIN tiers t ON t.id = s.current_tier_id
               WHERE s.discord_user_id = ?)`,
      [
        adId,
        draft.sponsorId,
        draft.slot,
        title,
        body,
        linkUrl,
        finalKey,
        draft.imageMime,
        draft.imageBytes,
        draft.imageWidth,
        draft.imageHeight,
        requested, // weight_alloc value
        draft.sponsorId, // SUM scope
        requested, // SUM addend
        draft.sponsorId, // tier lookup
      ],
    );
    if ((insertRes.rowCount ?? 0) === 0) {
      // Over budget (or sponsor has no tier ⇒ the subquery is NULL ⇒ the
      // comparison is false ⇒ 0 rows). Roll back the draft scaffolding and
      // clean up the freshly-copied final image.
      await deps.client.query('ROLLBACK');
      txOpen = false;
      try {
        await deleteObject(deps.s3, deps.bucket, finalKey);
      } catch (cleanupErr) {
        console.error('submit-modal: over-budget cleanup failed', { finalKey, cleanupErr });
      }
      return ephemeral(
        c,
        `重み ${requested} はティアの重み予算を超えています。配分を見直して再度起稿してください。`,
      );
    }

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
