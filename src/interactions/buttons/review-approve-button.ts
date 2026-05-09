import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { buildReviewOutcomeEmbed } from '../../discord/embeds/review.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { approveAd } from '../../services/review/approve.ts';
import { sendResultDM } from '../../services/review/dm.ts';
import { isReviewer } from '../../sponsors/reviewer-auth.ts';
import { ephemeral } from '../responses.ts';

type AdSnapshot = {
  id: string;
  slot: string;
  title: string;
  body: string;
  linkUrl: string;
  sponsorId: string | null;
  reviewMessageId: string | null;
  imageKey: string | null;
};

async function fetchAdSnapshot(client: PgClient, adId: string): Promise<AdSnapshot | null> {
  const res = await client.query<{
    id: string;
    slot: string;
    title: string;
    body: string;
    link_url: string;
    sponsor_id: string | null;
    review_message_id: string | null;
    image_key: string | null;
  }>(
    `SELECT id, slot, title, body, link_url, sponsor_id, review_message_id, image_key
       FROM ads
      WHERE id = $1`,
    [adId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    slot: r.slot,
    title: r.title,
    body: r.body,
    linkUrl: r.link_url,
    sponsorId: r.sponsor_id,
    reviewMessageId: r.review_message_id,
    imageKey: r.image_key,
  };
}

export type ApproveButtonDeps = {
  rest: DiscordRest;
  client: PgClient;
  reviewChannelId: string;
  workerBaseUrl: string;
  reviewerRoleId: string;
};

/**
 * Core handler for `review:approve:{adId}` button clicks. Tests inject all
 * deps; production wraps this with `withPgClient` + real REST in
 * `handleReviewApproveButton`.
 *
 * Flow: reviewer-auth → fetch ad snapshot → approveAd service (lookup tier +
 * optimistic UPDATE + log INSERT) → best-effort embed edit → ephemeral
 * confirmation. DM notification is deferred to P3.4.
 */
export async function runApproveButton(
  c: Context,
  payload: MessageComponentInteractionPayload,
  deps: ApproveButtonDeps,
): Promise<Response> {
  const reviewerCheck = payload.member ? { member: payload.member } : {};
  if (!isReviewer(reviewerCheck, deps.reviewerRoleId)) {
    return ephemeral(c, '⚠ レビュアー権限が必要です。');
  }

  // custom_id format: review:approve:{adId}
  const parts = payload.data.custom_id.split(':');
  const adId = parts[2] ?? '';
  if (!adId) return ephemeral(c, '広告 ID を取得できません。');

  const reviewerId = payload.member?.user.id ?? payload.user?.id ?? '';
  if (!reviewerId) return ephemeral(c, 'レビュアー情報を取得できませんでした。');

  // Snapshot ad data before mutation (used for embed editing). Reading after
  // approveAd would race with concurrent edits.
  const ad = await fetchAdSnapshot(deps.client, adId);
  if (!ad) return ephemeral(c, '対象の広告が見つかりません。');

  const result = await approveAd(deps.client, adId, reviewerId);
  if (!result.ok) {
    const message =
      result.reason === 'not_found'
        ? '対象の広告が見つかりません。'
        : result.reason === 'no_sponsor'
          ? 'スポンサーが設定されていない広告は承認できません。'
          : result.reason === 'no_tier'
            ? '対象スポンサーにティアロールが付与されていません。'
            : '他のレビュアーが既に処理しました。';
    return ephemeral(c, message);
  }

  // Best-effort: edit the original review embed so the channel reflects the
  // outcome. A failure here doesn't roll back the approval — admins can
  // re-trigger the embed update manually if needed.
  if (ad.reviewMessageId && ad.sponsorId) {
    try {
      const ext = ad.imageKey?.split('.').pop() ?? 'bin';
      const imageUrl = `${deps.workerBaseUrl}/images/ads/${ad.id}/orig.${ext}`;
      const outcomeEmbed = buildReviewOutcomeEmbed(
        {
          id: ad.id,
          slot: ad.slot,
          title: ad.title,
          body: ad.body,
          linkUrl: ad.linkUrl,
          imageUrl,
        },
        { id: ad.sponsorId },
        'approved',
        reviewerId,
      );
      await deps.rest.editMessage(deps.reviewChannelId, ad.reviewMessageId, {
        embeds: [outcomeEmbed],
        components: [],
      });
    } catch (err) {
      console.error('review-approve: embed edit failed (continuing)', err);
    }
  }

  // Send DM (P3.4). The fallback channel post for blocked DMs ships in P3.5.
  let dmStatus: 'sent' | 'blocked' | 'no_sponsor' | 'rest_error' = 'rest_error';
  if (ad.sponsorId) {
    const dmResult = await sendResultDM({
      rest: deps.rest,
      client: deps.client,
      ad: {
        id: ad.id,
        slot: ad.slot,
        title: ad.title,
        weightSnapshot: result.weightSnapshot,
        startsAt: new Date(),
      },
      sponsorId: ad.sponsorId,
      action: 'approved',
    });
    dmStatus = dmResult.ok ? 'sent' : dmResult.reason;
  } else {
    dmStatus = 'no_sponsor';
  }

  const dmNote =
    dmStatus === 'sent'
      ? 'DM で起稿者に通知しました。'
      : dmStatus === 'blocked'
        ? '起稿者の DM がオフのため、フォールバックチャンネル投稿は P3.5 で対応します。'
        : dmStatus === 'no_sponsor'
          ? '（house/placeholder のため DM 送信なし）'
          : '⚠ DM 送信時にエラーが発生しました（ログ参照）。';

  return ephemeral(c, `✅ 承認を確定しました。weight=${result.weightSnapshot} を凍結。${dmNote}`);
}

/**
 * Production entry point. Builds REST client + pg pool from env and delegates
 * to `runApproveButton`.
 */
export async function handleReviewApproveButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  return withPgClient(env.POSTGRES_URL, (client) =>
    runApproveButton(c, payload, {
      rest,
      client,
      reviewChannelId: env.REVIEW_CHANNEL_ID,
      workerBaseUrl: env.WORKER_BASE_URL,
      reviewerRoleId: env.REVIEWER_ROLE_ID,
    }),
  );
}
