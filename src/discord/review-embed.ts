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
 * Post a review embed to the review channel. Approve / Reject buttons are
 * intentionally out of scope for P2 — they will be added in P3.
 */
export async function postReviewEmbed(args: PostReviewEmbedArgs): Promise<void> {
  const imageUrl = `${args.workerBaseUrl}/images/ads/${args.ad.id}/orig.${args.ad.imageExt}`;
  const embed = {
    title: '📥 新しい広告審査依頼',
    url: args.ad.linkUrl,
    description: `**${args.ad.title}**`,
    fields: [
      { name: '本文', value: args.ad.body.slice(0, 1024), inline: false },
      { name: 'リンク URL', value: args.ad.linkUrl.slice(0, 1024), inline: false },
      { name: 'スロット', value: args.ad.slot, inline: true },
      { name: 'スポンサー', value: `<@${args.sponsor.id}>`, inline: true },
      { name: '広告 ID', value: `\`${args.ad.id}\``, inline: false },
    ],
    image: { url: imageUrl },
    timestamp: new Date().toISOString(),
  };
  await args.rest.createMessage(args.channelId, { embeds: [embed] });
}
