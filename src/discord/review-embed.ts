import { buildReviewButtons, buildReviewEmbed } from './embeds/review.ts';
import type { DiscordRest } from './rest.ts';

export type ReviewAd = {
  id: string;
  slot: string;
  title: string;
  body: string;
  linkUrl: string;
  // Fully-qualified URL Discord can fetch. Caller composes via
  // buildPublicImageUrl(S3_PUBLIC_BASE_URL, imageKey); pass null when the ad
  // has no image (kind=placeholder, etc.) and the embed omits the image block.
  imageUrl: string | null;
};

export type ReviewSponsor = {
  id: string;
};

export type PostReviewEmbedArgs = {
  rest: DiscordRest;
  channelId: string;
  ad: ReviewAd;
  sponsor: ReviewSponsor;
};

/**
 * Post a review embed (with Approve / Reject buttons) to the review channel.
 * Returns the created message id so the caller can persist it for later edits
 * (P3.2 / P3.3 update the same message when reviewers act).
 */
export async function postReviewEmbed(args: PostReviewEmbedArgs): Promise<{ messageId: string }> {
  const embed = buildReviewEmbed(
    {
      id: args.ad.id,
      slot: args.ad.slot,
      title: args.ad.title,
      body: args.ad.body,
      linkUrl: args.ad.linkUrl,
      ...(args.ad.imageUrl ? { imageUrl: args.ad.imageUrl } : {}),
    },
    { id: args.sponsor.id },
  );
  const buttons = buildReviewButtons(args.ad.id);
  const message = await args.rest.createMessage(args.channelId, {
    embeds: [embed],
    components: [buttons],
  });
  return { messageId: message.id };
}
