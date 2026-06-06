import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { insertReviewLog, updateAdStatusOptimistic } from '../../db/queries/review.ts';
import { buildReviewOutcomeEmbed } from '../../discord/embeds/review.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { ModalSubmitInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { buildPublicImageUrl } from '../../serve/router.ts';
import { sendResultDM } from '../../services/review/dm.ts';
import { createOrReuseFallbackChannel } from '../../services/review/fallback.ts';
import { isReviewer } from '../../sponsors/reviewer-auth.ts';
import { ephemeral } from '../responses.ts';

const CUSTOM_ID_PREFIX = 'review-reject-modal:';

type AdForOutcome = {
  id: string;
  slot: string;
  title: string;
  body: string;
  linkUrl: string;
  sponsorId: string | null;
  reviewMessageId: string | null;
  imageKey: string | null;
  imageMime: string | null;
};

async function fetchAdForOutcome(client: PgClient, adId: string): Promise<AdForOutcome | null> {
  const res = await client.query<{
    id: string;
    slot: string;
    title: string;
    body: string;
    link_url: string;
    sponsor_id: string | null;
    review_message_id: string | null;
    image_key: string | null;
    image_mime: string | null;
  }>(
    `SELECT id, slot, title, body, link_url, sponsor_id, review_message_id,
            image_key, image_mime
       FROM ads
      WHERE id = ?`,
    [adId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slot: row.slot,
    title: row.title,
    body: row.body,
    linkUrl: row.link_url,
    sponsorId: row.sponsor_id,
    reviewMessageId: row.review_message_id,
    imageKey: row.image_key,
    imageMime: row.image_mime,
  };
}

function findReason(payload: ModalSubmitInteractionPayload): string {
  for (const row of payload.data.components) {
    for (const comp of row.components) {
      if (comp.custom_id === 'reason') return comp.value;
    }
  }
  return '';
}

export type RejectModalDeps = {
  rest: DiscordRest;
  client: PgClient;
  reviewChannelId: string;
  s3PublicBaseUrl: string;
  reviewerRoleId: string;
  guildId: string;
  botId: string;
  fallbackCategoryId: string;
  uuid: () => string;
  // See ApproveButtonDeps: defers DM/fallback past the 3s Discord ack window.
  waitUntil?: (p: Promise<unknown>) => void;
};

/**
 * Core handler for `review-reject-modal:{adId}` submissions. Tests inject all
 * deps; production wraps this with `withPgClient` + real REST in
 * `handleRejectModal`.
 *
 * Flow: reviewer-auth → re-validate reason (10–500 chars) → fetch ad →
 * optimistic `pending → rejected` UPDATE → review_logs INSERT → best-effort
 * embed edit → ephemeral confirmation. DM notification is deferred to P3.4.
 */
export async function runRejectModal(
  c: Context,
  payload: ModalSubmitInteractionPayload,
  deps: RejectModalDeps,
): Promise<Response> {
  const reviewerCheck = payload.member ? { member: payload.member } : {};
  if (!isReviewer(reviewerCheck, deps.reviewerRoleId)) {
    return ephemeral(c, '⚠ レビュアー権限が必要です。');
  }

  const cid = payload.data.custom_id;
  const adId = cid.startsWith(CUSTOM_ID_PREFIX) ? cid.slice(CUSTOM_ID_PREFIX.length) : '';
  if (!adId) return ephemeral(c, '広告 ID を取得できません。');

  const reason = findReason(payload).trim();
  if (reason.length < 10 || reason.length > 500) {
    return ephemeral(c, '却下理由は 10〜500 文字で入力してください。');
  }

  const reviewerId = payload.member?.user.id ?? payload.user?.id ?? '';
  if (!reviewerId) return ephemeral(c, 'レビュアー情報を取得できませんでした。');

  // Snapshot ad data before status update (we need title/body/linkUrl/sponsor
  // for the outcome embed; reading after the UPDATE would be racy with other
  // concurrent edits).
  const ad = await fetchAdForOutcome(deps.client, adId);
  if (!ad) return ephemeral(c, '対象の広告が見つかりません。');

  // Optimistic status transition: pending → rejected. Returns 'race' if some
  // other reviewer already moved this ad out of `pending`.
  // UPDATE + log INSERT run in a single transaction so a partial failure can't
  // leave the ad rejected without a corresponding review_logs entry.
  await deps.client.query('BEGIN');
  try {
    const updateResult = await updateAdStatusOptimistic(deps.client, adId, 'pending', {
      status: 'rejected',
      rejectReason: reason,
      reviewedBy: reviewerId,
    });
    if (!updateResult.ok) {
      await deps.client.query('ROLLBACK');
      return ephemeral(c, '他のレビュアーが既に処理しました。');
    }
    await insertReviewLog(deps.client, adId, reviewerId, 'rejected', reason);
    await deps.client.query('COMMIT');
  } catch (err) {
    try {
      await deps.client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Embed edit + DM + fallback channel can blow past Discord's 3s window
  // (we logged 5s+ wallTimes). Defer them so the modal closes immediately.
  // Tests omit waitUntil and the work is awaited inline.
  const reviewedAt = new Date();
  const deferred = async () => {
    if (ad.reviewMessageId && ad.sponsorId) {
      try {
        const imageUrl = buildPublicImageUrl(deps.s3PublicBaseUrl, ad.imageKey);
        const outcomeEmbed = buildReviewOutcomeEmbed(
          {
            id: ad.id,
            slot: ad.slot,
            title: ad.title,
            body: ad.body,
            linkUrl: ad.linkUrl,
            ...(imageUrl ? { imageUrl } : {}),
          },
          { id: ad.sponsorId },
          'rejected',
          reviewerId,
          reason,
        );
        await deps.rest.editMessage(deps.reviewChannelId, ad.reviewMessageId, {
          embeds: [outcomeEmbed],
          components: [],
        });
      } catch (err) {
        console.error('review-reject: embed edit failed (continuing)', err);
      }
    }

    if (!ad.sponsorId) return;
    try {
      const dmResult = await sendResultDM({
        rest: deps.rest,
        client: deps.client,
        ad: {
          id: ad.id,
          slot: ad.slot,
          title: ad.title,
          reviewedAt,
        },
        sponsorId: ad.sponsorId,
        action: 'rejected',
        reason,
      });
      if (!dmResult.ok && dmResult.reason === 'blocked') {
        await createOrReuseFallbackChannel({
          rest: deps.rest,
          client: deps.client,
          guildId: deps.guildId,
          botId: deps.botId,
          categoryId: deps.fallbackCategoryId,
          ad: {
            id: ad.id,
            slot: ad.slot,
            title: ad.title,
            reviewedAt,
          },
          sponsorId: ad.sponsorId,
          action: 'rejected',
          reason,
          uuid: deps.uuid,
        });
      }
    } catch (err) {
      console.error('review-reject: DM/fallback failed (deferred)', err);
    }
  };

  if (deps.waitUntil) {
    deps.waitUntil(deferred());
  } else {
    await deferred();
  }

  return ephemeral(c, '✅ 却下を確定しました。通知は別途送信します。');
}

/**
 * Production entry point. Builds REST client + pg pool from env and delegates
 * to `runRejectModal`.
 */
export async function handleRejectModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  return withPgClient(env, (client) =>
    runRejectModal(c, payload, {
      rest,
      client,
      reviewChannelId: env.REVIEW_CHANNEL_ID,
      s3PublicBaseUrl: env.S3_PUBLIC_BASE_URL,
      reviewerRoleId: env.REVIEWER_ROLE_ID,
      guildId: env.GUILD_ID,
      botId: env.DISCORD_APP_BOT_ID,
      fallbackCategoryId: env.FALLBACK_CHANNEL_CATEGORY_ID,
      uuid: () => crypto.randomUUID(),
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    }),
  );
}
