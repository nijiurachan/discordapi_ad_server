import { Hono } from 'hono';
import { withPgClient } from '../db/client.ts';
import type { Bindings } from '../env.ts';
import { hashIP } from '../utils/ip-hash.ts';
import { serveAds } from './pick.ts';
import { generateImpressionToken } from './token.ts';

export const serveRouter = new Hono<{ Bindings: Bindings }>();

const MAX_N = 5;

export function parseN(raw: string | undefined): number {
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, MAX_N);
}

serveRouter.get('/serve', async (c) => {
  const slot = c.req.query('slot') ?? 'default';
  const n = parseN(c.req.query('n'));

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const ipHash = await hashIP(ip, c.env.IP_HASH_SALT_BOOTSTRAP);

  const ads = await withPgClient(c.env.POSTGRES_URL, (client) => serveAds(client, slot, n));
  if (ads.length === 0) {
    return new Response(null, { status: 204 });
  }

  const servedAt = new Date();
  const adsWithTokens = await Promise.all(
    ads.map(async (ad) => {
      const token = await generateImpressionToken(
        { adId: ad.id, slot, ipHash },
        servedAt,
        c.env.IMPRESSION_TOKEN_SECRET,
      );
      return {
        id: ad.id,
        kind: ad.kind,
        title: ad.title,
        body: ad.body,
        image_url: `${c.env.WORKER_BASE_URL}/ads/image/${ad.id}`,
        click_url: `${c.env.WORKER_BASE_URL}/ads/click/${ad.id}`,
        impression_token: token,
      };
    }),
  );

  return c.json({
    slot,
    served_at: servedAt.toISOString(),
    ads: adsWithTokens,
  });
});
