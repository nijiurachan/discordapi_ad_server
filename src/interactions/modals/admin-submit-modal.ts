import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { setAdReviewMessageId } from '../../db/queries/review.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import { postReviewEmbed } from '../../discord/review-embed.ts';
import type { ModalSubmitInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { copyObject, createS3Client, deleteObject } from '../../storage/s3.ts';
import { fetchFormatRules } from '../../validation/rules.ts';
import { validateBody, validateLinkUrl, validateTitle } from '../../validation/text.ts';
import { ephemeral } from '../responses.ts';

export type AdminSubmitModalDeps = {
  rest: DiscordRest;
  client: PgClient;
  s3: S3Client;
  bucket: string;
  reviewChannelId: string;
  workerBaseUrl: string;
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
      WHERE id = $1`,
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
      WHERE s.discord_user_id = $1`,
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
  const ext = draft.imageKey.split('.').pop() ?? 'bin';
  const finalKey = `ads/${adId}/orig.${ext}`;

  try {
    await copyObject(deps.s3, deps.bucket, draft.imageKey, finalKey);
  } catch (err) {
    console.error('admin-submit-modal: S3 copy failed', err);
    return ephemeral(c, '画像の本格保存に失敗しました。');
  }

  const isAutoApproved = draft.autoApprove || draft.kind !== 'regular';
  const status = isAutoApproved ? 'approved' : 'pending';

  if (draft.kind === 'placeholder') {
    const dup = await deps.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM ads
        WHERE kind = 'placeholder' AND slot = $1 AND status = 'approved'`,
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
  const startsAt = isAutoApproved ? 'now()' : 'NULL';
  const endsAtClause =
    draft.endsInDays && draft.endsInDays > 0
      ? `now() + interval '${draft.endsInDays} days'`
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
      'SELECT id FROM ad_drafts WHERE id = $1 FOR UPDATE',
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, ${startsAt}, ${endsAtClause}, $15, $16, $17)`,
      [
        adId,
        draft.sponsorId,
        draft.kind,
        draft.slot,
        title,
        body,
        linkUrl,
        finalKey,
        draft.imageMime,
        draft.imageBytes,
        draft.imageWidth,
        draft.imageHeight,
        status,
        weightSnapshot,
        isAutoApproved ? draft.createdByAdmin : null,
        isAutoApproved ? new Date() : null,
        draft.createdByAdmin,
      ],
    );

    await deps.client.query(
      `INSERT INTO admin_logs (actor_id, action, target_kind, target_id, after)
         VALUES ($1, $2, 'ad', $3, $4::jsonb)`,
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

    await deps.client.query('DELETE FROM ad_drafts WHERE id = $1', [draftId]);
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
      const result = await postReviewEmbed({
        rest: deps.rest,
        channelId: deps.reviewChannelId,
        workerBaseUrl: deps.workerBaseUrl,
        ad: { id: adId, slot: draft.slot, title, body, linkUrl, imageExt: ext },
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
  return withPgClient(c.env.POSTGRES_URL, (client) =>
    runAdminSubmitModal(c, payload, {
      rest,
      client,
      s3,
      bucket: c.env.S3_BUCKET,
      reviewChannelId: c.env.REVIEW_CHANNEL_ID,
      workerBaseUrl: c.env.WORKER_BASE_URL,
      uuid: () => crypto.randomUUID(),
    }),
  );
}
