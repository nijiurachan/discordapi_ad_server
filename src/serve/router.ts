import { Hono } from 'hono';
import { withPgClient } from '../db/client.ts';
import { insertEventIfNotRecent } from '../db/queries/ad-events.ts';
import type { Bindings } from '../env.ts';
import { shouldRecordEvent } from '../utils/event-filter.ts';
import { hashIP } from '../utils/ip-hash.ts';
import { getDailySalt } from '../utils/salt.ts';
import { handleClick } from './click.ts';
import { handleImage } from './image.ts';
import { type ServedAd, serveAds } from './pick.ts';
import { clickRateLimit, serveRateLimit } from './rate-limit.ts';
import { requireSiteKey } from './site-key.ts';
import { generateImpressionToken } from './token.ts';

export const serveRouter = new Hono<{ Bindings: Bindings }>();

// /ads/serve: optional site-key validation + per-IP rate limit (60/min).
serveRouter.use('/serve', requireSiteKey, serveRateLimit);
// /ads/click/:adId: per-IP+adId rate limit (10/min). No site key (clicks come from third-party HTML).
serveRouter.use('/click/:adId', clickRateLimit);

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

  // Track impressions (fire-and-forget; doesn't block the response).
  const ua = c.req.header('user-agent') ?? null;
  const method = c.req.method;
  if (shouldRecordEvent({ method, ua })) {
    c.executionCtx.waitUntil(trackImpressions(c.env, ads, slot, ip, ua));
  }

  return c.json({
    slot,
    served_at: servedAt.toISOString(),
    ads: adsWithTokens,
  });
});

serveRouter.get('/image/:adId', handleImage);
serveRouter.get('/click/:adId', handleClick);

/**
 * Insert one impression row per non-placeholder served ad. Called via
 * `executionCtx.waitUntil` so the response isn't blocked. Errors are swallowed
 * (logged only) — tracking must never break delivery.
 */
export async function trackImpressions(
  env: Bindings,
  ads: ServedAd[],
  slot: string,
  ip: string,
  ua: string | null,
): Promise<void> {
  // Filter out placeholder kinds before any DB work (spec §5.6).
  const trackable = ads.filter((a) => a.kind !== 'placeholder');
  if (trackable.length === 0) return;

  try {
    await withPgClient(env.POSTGRES_URL, async (client) => {
      const salt = await getDailySalt(client, env.IP_HASH_SALT_BOOTSTRAP);
      const ipHash = await hashIP(ip, salt);
      for (const ad of trackable) {
        await insertEventIfNotRecent(client, {
          adId: ad.id,
          eventType: 'impression',
          ipHash,
          ua,
          slot,
        });
        // result.ok===false means dedup hit; nothing to do.
      }
    });
  } catch (err) {
    console.warn('serve: impression tracking failed', { err });
  }
}
