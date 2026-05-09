import { formatJpDate } from '../../interactions/format.ts';

export type ResultDmAdInfo = {
  id: string;
  slot: string;
  title: string;
  weightSnapshot?: number | null;
  startsAt?: Date | null;
  reviewedAt?: Date | null;
};

export function buildApproveDmEmbed(ad: ResultDmAdInfo): Record<string, unknown> {
  return {
    title: '✅ 広告が承認されました',
    color: 0x2ecc71,
    description: `**${ad.title}**`,
    fields: [
      { name: 'スロット', value: ad.slot, inline: true },
      { name: '広告 ID', value: `\`${ad.id}\``, inline: false },
      { name: '配信開始', value: formatJpDate(ad.startsAt ?? null), inline: true },
      {
        name: '重み (weight)',
        value: String(ad.weightSnapshot ?? '—'),
        inline: true,
      },
    ],
    footer: { text: '統計や取り下げは #広告起稿 の「📋 自分の広告一覧」から確認できます。' },
    timestamp: new Date().toISOString(),
  };
}

export function buildRejectDmEmbed(ad: ResultDmAdInfo, reason: string): Record<string, unknown> {
  return {
    title: '❌ 広告が却下されました',
    color: 0xe74c3c,
    description: `**${ad.title}**`,
    fields: [
      { name: 'スロット', value: ad.slot, inline: true },
      { name: '広告 ID', value: `\`${ad.id}\``, inline: false },
      { name: '却下日時', value: formatJpDate(ad.reviewedAt ?? new Date()), inline: true },
      { name: '却下理由', value: `> ${reason.slice(0, 1000)}`, inline: false },
    ],
    footer: {
      text: '修正のうえ再起稿してください。質問は審査者にメンションで問い合わせ可能です。',
    },
    timestamp: new Date().toISOString(),
  };
}
