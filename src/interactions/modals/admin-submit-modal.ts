import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { setAdReviewMessageId } from '../../db/queries/review.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import { postReviewEmbed } from '../../discord/review-embed.ts';
import type { ModalSubmitInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { buildPublicImageUrl } from '../../serve/router.ts';
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

export type AdminSubmitModalDeps = {
  rest: DiscordRest;
  client: PgClient;
  s3: S3Client;
  bucket: string;
  reviewChannelId: string;
  s3PublicBaseUrl: string;
  uuid: () => string;
};

type AdminAdDraft = {
  id: string;
  sponsorId: string | null;
  slot: string;
  imageKey: string;
  imageMime: string;
  imageBytes: number;
  imageWidth: number | null;
  imageHeight: number | null;
  kind: string;
  weight: number | null;
  autoApprove: boolean;
  endsInDays: number | null;
  createdByAdmin: string;
  expiresAt: Date;
};

async function fetchDraft(client: PgClient, draftId: string): Promise<AdminAdDraft | null> {
  const res = await client.query<{
    id: string;
    sponsor_id: string | null;
    slot: string;
    image_key: string;
    image_mime: string;
    image_bytes: number;
    image_width: number | null;
    image_height: number | null;
    kind: string | null;
    weight: number | null;
    auto_approve: boolean | null;
    ends_in_days: number | null;
    created_by_admin: string | null;
    expires_at: Date | string;
  }>(
    `SELECT id, sponsor_id, slot, image_key, image_mime, image_bytes,
            image_width, image_height, kind, weight, auto_approve,
            ends_in_days, created_by_admin, expires_at
       FROM ad_drafts
      WHERE id = ?`,
    [draftId],
  );
  const row = res.rows[0];
  if (!row || !row.kind || !row.created_by_admin) return null;
  return {
    id: row.id,
    sponsorId: row.sponsor_id,
    slot: row.slot,
    imageKey: row.image_key,
    imageMime: row.image_mime,
    imageBytes: row.image_bytes,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    kind: row.kind,
    weight: row.weight,
    autoApprove: row.auto_approve ?? false,
    endsInDays: row.ends_in_days,
    createdByAdmin: row.created_by_admin,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
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

async function fetchSponsorTierWeight(client: PgClient, sponsorId: string): Promise<number | null> {
  const res = await client.query<{ weight: number | null }>(
    `SELECT t.weight
       FROM sponsors s
       LEFT JOIN tiers t ON t.id = s.current_tier_id
      WHERE s.discord_user_id = ?`,
    [sponsorId],
  );
  return res.rows[0]?.weight ?? null;
}

export async function runAdminSubmitModal(
  c: Context,
  payload: ModalSubmitInteractionPayload,
  deps: AdminSubmitModalDeps,
): Promise<Response> {
  const customId = payload.data.custom_id;
  if (!customId.startsWith('admin-submit:')) {
    return ephemeral(c, '不正な custom_id です');
  }
  const draftId = customId.slice('admin-submit:'.length);

  const draft = await fetchDraft(deps.client, draftId);
  if (!draft) {
    return ephemeral(c, '管理下書きが見つかりません。再度起稿してください。');
  }
  if (draft.expiresAt.getTime() < Date.now()) {
    return ephemeral(c, '下書きの有効期限が切れています。再度起稿してください。');
  }

  const title = findTextValue(payload, 'title');
  const body = findTextValue(payload, 'body');
  const linkUrl = findTextValue(payload, 'link_url');

  const rules = await fetchFormatRules(deps.client, draft.slot);
  if (!rules) return ephemeral(c, '指定された slot の入稿ルールが未設定です');
  const titleResult = validateTitle(rules, title);
  if (!titleResult.ok) return ephemeral(c, titleResult.error);
  const bodyResult = validateBody(rules, body);
  if (!bodyResult.ok) return ephemeral(c, bodyResult.error);
  const linkResult = validateLinkUrl(rules, linkUrl);
  if (!linkResult.ok) return ephemeral(c, linkResult.error);

  const adId = deps.uuid();
  // Final extension follows the post-resize PNG output rather than the input
  // MIME — the bytes stored at finalKey are always the resized PNG.
  const finalKey = `ads/${adId}/orig.${BANNER_OUTPUT_EXT}`;

  let resizedBytes: Uint8Array;
  try {
    const src = await getObject(deps.s3, deps.bucket, draft.imageKey);
    if (!src) {
      console.error('admin-submit-modal: staging missing', draft.imageKey);
      return ephemeral(c, '下書き画像が見つかりません。');
    }
    const rawBytes = new Uint8Array(await new Response(src.body).arrayBuffer());
    resizedBytes = resizeBanner(rawBytes).bytes;
    await putObject(deps.s3, deps.bucket, finalKey, resizedBytes, BANNER_OUTPUT_MIME);
  } catch (err) {
    console.error('admin-submit-modal: resize/save failed', err);
    return ephemeral(c, '画像の本格保存に失敗しました。');
  }

  const isAutoApproved = draft.autoApprove || draft.kind !== 'regular';
  const status = isAutoApproved ? 'approved' : 'pending';

  if (draft.kind === 'placeholder') {
    const dup = await deps.client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM ads
        WHERE kind = 'placeholder' AND slot = ? AND status = 'approved'`,
      [draft.slot],
    );
    if (Number(dup.rows[0]?.count ?? '0') > 0) {
      try {
        await deleteObject(deps.s3, deps.bucket, finalKey);
      } catch (e) {
        console.error('admin-submit-modal: cleanup after placeholder dup failed', e);
      }
      return ephemeral(
        c,
        `❌ slot=\`${draft.slot}\` の placeholder は既に存在します。先に既存を強制終了してください。`,
      );
    }
  }
  const startsAt = isAutoApproved ? '(unixepoch() * 1000)' : 'NULL';
  // SQLite has no `interval` literal; convert days→ms at compile time.
  // `endsInDays` is a JS number gated 1..365 by Discord command choices, so the
  // product stays well below MAX_SAFE_INTEGER and inlining is safe.
  const endsAtClause =
    draft.endsInDays && draft.endsInDays > 0
      ? `(unixepoch() * 1000) + ${draft.endsInDays * 86_400_000}`
      : 'NULL';
  let weightSnapshot: number | null = draft.weight ?? null;
  if (isAutoApproved && weightSnapshot === null && draft.kind === 'regular' && draft.sponsorId) {
    weightSnapshot = await fetchSponsorTierWeight(deps.client, draft.sponsorId);
  }
  if (isAutoApproved && weightSnapshot === null) {
    weightSnapshot = draft.kind === 'placeholder' ? 0 : 1;
  }

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
      } catch (e) {
        console.error('admin-submit-modal: cleanup failed', e);
      }
      return ephemeral(c, '下書きが既に処理済みです。');
    }

    await deps.client.query(
      `INSERT INTO ads
         (id, sponsor_id, kind, slot, title, body, link_url,
          image_key, image_mime, image_bytes, image_width, image_height,
          status, weight_snapshot, starts_at, ends_at,
          reviewed_by, reviewed_at, created_by_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ${startsAt}, ${endsAtClause}, ?, ?, ?)`,
      [
        adId,
        draft.sponsorId,
        draft.kind,
        draft.slot,
        title,
        body,
        linkUrl,
        finalKey,
        BANNER_OUTPUT_MIME,
        resizedBytes.byteLength,
        BANNER_WIDTH,
        BANNER_HEIGHT,
        status,
        weightSnapshot,
        isAutoApproved ? draft.createdByAdmin : null,
        // `reviewed_at` is integer (epoch ms); binding a Date object would
        // serialize as ISO string. Use Date.now() to stay numeric.
        isAutoApproved ? Date.now() : null,
        draft.createdByAdmin,
      ],
    );

    await deps.client.query(
      `INSERT INTO admin_logs (actor_id, action, target_kind, target_id, after)
         VALUES (?, ?, 'ad', ?, ?)`,
      [
        draft.createdByAdmin,
        isAutoApproved ? 'admin_submit_auto_approve' : 'admin_submit_pending',
        adId,
        JSON.stringify({
          kind: draft.kind,
          slot: draft.slot,
          weight: weightSnapshot,
          ends_in_days: draft.endsInDays,
          auto_approve: draft.autoApprove,
          sponsor_id: draft.sponsorId,
        }),
      ],
    );

    await deps.client.query('DELETE FROM ad_drafts WHERE id = ?', [draftId]);
    await deps.client.query('COMMIT');
    txOpen = false;
  } catch (err) {
    console.error('admin-submit-modal: tx failed', err);
    if (txOpen) {
      try {
        await deps.client.query('ROLLBACK');
      } catch (rbErr) {
        console.error('admin-submit-modal: rollback failed', rbErr);
      }
    }
    try {
      await deleteObject(deps.s3, deps.bucket, finalKey);
    } catch (e) {
      console.error('admin-submit-modal: cleanup deleteObject failed', e);
    }
    return ephemeral(c, '広告の登録に失敗しました。再度お試しください。');
  }

  try {
    await deleteObject(deps.s3, deps.bucket, draft.imageKey);
  } catch (err) {
    console.error('admin-submit-modal: staging delete failed (non-fatal)', err);
  }

  if (!isAutoApproved && draft.sponsorId) {
    try {
      const imageUrl = buildPublicImageUrl(deps.s3PublicBaseUrl, finalKey);
      const result = await postReviewEmbed({
        rest: deps.rest,
        channelId: deps.reviewChannelId,
        ad: { id: adId, slot: draft.slot, title, body, linkUrl, imageUrl },
        sponsor: { id: draft.sponsorId },
      });
      try {
        await setAdReviewMessageId(deps.client, adId, result.messageId);
      } catch (persistErr) {
        console.error('admin-submit-modal: setAdReviewMessageId failed', persistErr);
      }
    } catch (err) {
      console.error('admin-submit-modal: review embed failed (non-fatal)', err);
    }
  }

  const summary = isAutoApproved
    ? `✅ 即時承認で広告を登録しました（kind=${draft.kind}, weight=${weightSnapshot}）`
    : `✅ pending として登録しました。レビューチャンネルにて審査されます（kind=${draft.kind}）`;
  return ephemeral(c, summary);
}

export async function handleAdminSubmitModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  const rest = createDiscordRest({ token: c.env.DISCORD_BOT_TOKEN });
  const s3 = createS3Client({
    endpoint: c.env.S3_ENDPOINT,
    region: c.env.S3_REGION,
    accessKeyId: c.env.S3_ACCESS_KEY_ID,
    secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
  });
  return withPgClient(c.env, (client) =>
    runAdminSubmitModal(c, payload, {
      rest,
      client,
      s3,
      bucket: c.env.S3_BUCKET,
      reviewChannelId: c.env.REVIEW_CHANNEL_ID,
      s3PublicBaseUrl: c.env.S3_PUBLIC_BASE_URL,
      uuid: () => crypto.randomUUID(),
    }),
  );
}
