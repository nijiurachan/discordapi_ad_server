import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { buildReviewOutcomeEmbed } from '../../discord/embeds/review.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { buildPublicImageUrl } from '../../serve/router.ts';
import { approveAd } from '../../services/review/approve.ts';
import { sendResultDM } from '../../services/review/dm.ts';
import { createOrReuseFallbackChannel } from '../../services/review/fallback.ts';
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
      WHERE id = ?`,
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
  s3PublicBaseUrl: string;
  reviewerRoleId: string;
  guildId: string;
  botId: string;
  fallbackCategoryId: string;
  uuid: () => string;
  // When provided, DM + fallback channel work is fire-and-forget under
  // c.executionCtx.waitUntil so the modal/button ack stays inside Discord's
  // 3-second window. Tests omit this and the deferred work is awaited inline.
  waitUntil?: (p: Promise<unknown>) => void;
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
            : result.reason === 'budget_exceeded'
              ? 'スポンサーの重み予算を超過しています（ティア降格の可能性）。配分を見直してください。'
              : '他のレビュアーが既に処理しました。';
    return ephemeral(c, message);
  }

  // Embed edit + DM + fallback channel involve REST hops that can blow past
  // Discord's 3-second interaction window (we logged 5s+ wallTimes on the DM
  // path). Run them after returning the ack so the user sees a prompt
  // "✅ 承認確定" instead of "問題が発生しました". In tests, waitUntil is
  // absent and the work is awaited inline so assertions still see the side
  // effects.
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

    if (!ad.sponsorId) return;
    try {
      const dmResult = await sendResultDM({
        rest: deps.rest,
        client: deps.client,
        ad: {
          id: ad.id,
          slot: ad.slot,
          title: ad.title,
          weightSnapshot: result.weightSnapshot,
          startsAt: result.startsAt,
        },
        sponsorId: ad.sponsorId,
        action: 'approved',
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
            weightSnapshot: result.weightSnapshot,
            startsAt: result.startsAt,
          },
          sponsorId: ad.sponsorId,
          action: 'approved',
          uuid: deps.uuid,
        });
      }
    } catch (err) {
      console.error('review-approve: DM/fallback failed (deferred)', err);
    }
  };

  if (deps.waitUntil) {
    deps.waitUntil(deferred());
  } else {
    await deferred();
  }

  return ephemeral(
    c,
    `✅ 承認を確定しました。weight=${result.weightSnapshot} を凍結。通知は別途送信します。`,
  );
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
  return withPgClient(env, (client) =>
    runApproveButton(c, payload, {
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
