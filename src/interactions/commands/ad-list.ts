import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { getSponsorAds } from '../../db/queries/ads.ts';
import type {
  ActionRowComponent,
  ApplicationCommandInteractionPayload,
  MessageComponentInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { presignGetUrl } from '../../storage/s3-presign.ts';
import { createS3Client } from '../../storage/s3.ts';
import { formatJpDate, statusLabel } from '../format.ts';
import { ephemeral } from '../responses.ts';

export type AdListDeps = {
  client: PgClient;
  s3: S3Client;
  bucket: string;
  presignTtlSeconds: number;
  // Injectable for tests; defaults to presignGetUrl.
  presignImpl?: (s3: S3Client, bucket: string, key: string, ttl: number) => Promise<string>;
};

const WITHDRAWABLE = new Set(['pending', 'approved', 'paused']);

function userIdOf(payload: {
  member?: { user: { id: string } };
  user?: { id: string };
}): string | null {
  return payload.member?.user.id ?? payload.user?.id ?? null;
}

export async function runAdList(c: Context, userId: string, deps: AdListDeps): Promise<Response> {
  const ads = await getSponsorAds(deps.client, userId, 5);
  if (ads.length === 0) {
    return ephemeral(c, 'まだ広告が登録されていません。`/ad submit` から起稿してください。');
  }

  const presign = deps.presignImpl ?? presignGetUrl;

  // Build embeds (one per ad, max 5)
  const embeds = await Promise.all(
    ads.map(async (ad) => {
      let imageUrl: string | null = null;
      if (ad.imageKey) {
        try {
          imageUrl = await presign(deps.s3, deps.bucket, ad.imageKey, deps.presignTtlSeconds);
        } catch (err) {
          console.warn('ad-list: presign failed', { adId: ad.id, key: ad.imageKey, err });
          imageUrl = null;
        }
      }
      const fields = [
        { name: 'ステータス', value: statusLabel(ad.status), inline: true },
        { name: 'スロット', value: ad.slot, inline: true },
        { name: '配信開始', value: formatJpDate(ad.startsAt), inline: true },
        { name: '広告 ID', value: `\`${ad.id}\``, inline: false },
      ];
      const embed: {
        title: string;
        url: string;
        description: string;
        fields: { name: string; value: string; inline?: boolean }[];
        footer: { text: string };
        image?: { url: string };
      } = {
        title: ad.title,
        url: ad.linkUrl,
        description: ad.body.slice(0, 1024),
        fields,
        footer: { text: ad.status === 'withdrawn' ? '取り下げ済み' : '' },
      };
      if (imageUrl) embed.image = { url: imageUrl };
      return embed;
    }),
  );

  // Build action rows (only for withdrawable ads, max 5)
  const rows: ActionRowComponent[] = ads
    .filter((ad) => WITHDRAWABLE.has(ad.status))
    .slice(0, 5)
    .map((ad) => ({
      type: 1,
      components: [
        {
          type: 2,
          style: 4, // DANGER
          custom_id: `ad:withdraw:${ad.id}`,
          label: `↩ 取り下げ: ${ad.title.slice(0, 40)}`,
        },
      ],
    }));

  return c.json({
    type: 4,
    data: {
      content:
        ads.length === 5
          ? '直近 5 件を表示しています。それ以外は `/ad list` で再取得してください。'
          : '',
      embeds,
      components: rows,
      flags: 64, // EPHEMERAL
    },
  });
}

export async function handleAdList(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload | MessageComponentInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const userId = userIdOf(payload);
  if (!userId) return ephemeral(c, 'ユーザー情報を取得できませんでした');
  const s3 = createS3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  return withPgClient(env.POSTGRES_URL, (client) =>
    runAdList(c, userId, {
      client,
      s3,
      bucket: env.S3_BUCKET,
      presignTtlSeconds: 300,
    }),
  );
}
