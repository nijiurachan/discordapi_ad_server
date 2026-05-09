import { buildReviewButtons, buildReviewEmbed } from './embeds/review.ts';
import type { DiscordRest } from './rest.ts';

export type ReviewAd = {
  id: string;
  slot: string;
  title: string;
  body: string;
  linkUrl: string;
  imageExt: string;
};

export type ReviewSponsor = {
  id: string;
};

export type PostReviewEmbedArgs = {
  rest: DiscordRest;
  channelId: string;
  workerBaseUrl: string;
  ad: ReviewAd;
  sponsor: ReviewSponsor;
};

/**
 * Post a review embed (with Approve / Reject buttons) to the review channel.
 * Returns the created message id so the caller can persist it for later edits
 * (P3.2 / P3.3 update the same message when reviewers act).
 */
export async function postReviewEmbed(args: PostReviewEmbedArgs): Promise<{ messageId: string }> {
  const imageUrl = `${args.workerBaseUrl}/images/ads/${args.ad.id}/orig.${args.ad.imageExt}`;
  const embed = buildReviewEmbed(
    {
      id: args.ad.id,
      slot: args.ad.slot,
      title: args.ad.title,
      body: args.ad.body,
      linkUrl: args.ad.linkUrl,
      imageUrl,
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
