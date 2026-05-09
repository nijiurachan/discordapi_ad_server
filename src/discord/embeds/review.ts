import type { ActionRowComponent, ButtonComponent } from '../types.ts';

export type ReviewEmbedAd = {
  id: string;
  slot: string;
  title: string;
  body: string;
  linkUrl: string;
  imageUrl?: string;
};

export type ReviewEmbedSponsor = {
  id: string;
  displayName?: string;
};

export function buildReviewEmbed(
  ad: ReviewEmbedAd,
  sponsor: ReviewEmbedSponsor,
): Record<string, unknown> {
  return {
    title: '📥 新しい広告審査依頼',
    url: ad.linkUrl,
    description: `**${ad.title}**`,
    color: 0x3498db, // blue
    fields: [
      { name: '本文', value: ad.body.slice(0, 1024), inline: false },
      { name: 'リンク URL', value: ad.linkUrl.slice(0, 1024), inline: false },
      { name: 'スロット', value: ad.slot, inline: true },
      { name: 'スポンサー', value: `<@${sponsor.id}>`, inline: true },
      { name: '広告 ID', value: `\`${ad.id}\``, inline: false },
    ],
    timestamp: new Date().toISOString(),
    ...(ad.imageUrl ? { image: { url: ad.imageUrl } } : {}),
  };
}

export type ReviewAction = 'approved' | 'rejected' | 'withdrawn';

export function buildReviewOutcomeEmbed(
  ad: ReviewEmbedAd,
  sponsor: ReviewEmbedSponsor,
  action: ReviewAction,
  reviewerId: string,
  reason?: string,
): Record<string, unknown> {
  const isApproved = action === 'approved';
  const isWithdrawn = action === 'withdrawn';
  const titleIcon = isApproved ? '✅' : isWithdrawn ? '↩' : '❌';
  const titleVerb = isApproved ? '承認済' : isWithdrawn ? '取り下げ' : '却下';
  const color = isApproved ? 0x2ecc71 : isWithdrawn ? 0x95a5a6 : 0xe74c3c;
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: '本文', value: ad.body.slice(0, 1024), inline: false },
    { name: 'リンク URL', value: ad.linkUrl.slice(0, 1024), inline: false },
    { name: 'スロット', value: ad.slot, inline: true },
    { name: 'スポンサー', value: `<@${sponsor.id}>`, inline: true },
    { name: '広告 ID', value: `\`${ad.id}\``, inline: false },
    { name: 'レビュアー', value: `<@${reviewerId}>`, inline: true },
  ];
  if (reason) fields.push({ name: '理由', value: reason.slice(0, 1024), inline: false });
  return {
    title: `${titleIcon} ${titleVerb} by <@${reviewerId}>`,
    url: ad.linkUrl,
    description: `**${ad.title}**`,
    color,
    fields,
    timestamp: new Date().toISOString(),
    ...(ad.imageUrl ? { image: { url: ad.imageUrl } } : {}),
  };
}

export function buildReviewButtons(adId: string): ActionRowComponent {
  const approve: ButtonComponent = {
    type: 2,
    style: 3, // SUCCESS (green)
    custom_id: `review:approve:${adId}`,
    label: '✅ 承認',
  };
  const reject: ButtonComponent = {
    type: 2,
    style: 4, // DANGER (red)
    custom_id: `review:reject:${adId}`,
    label: '❌ 却下',
  };
  return { type: 1, components: [approve, reject] };
}
