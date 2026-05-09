import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../db/client.ts';
import type { Bindings } from '../env.ts';
import { createS3Client, getObject } from '../storage/s3.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL_SECONDS = 86_400; // 24h

export function isValidAdId(adId: string): boolean {
  return UUID_RE.test(adId);
}

export async function getAdImage(
  client: PgClient,
  adId: string,
): Promise<{ imageKey: string; imageMime: string | null } | null> {
  const res = await client.query<{ image_key: string | null; image_mime: string | null }>(
    'SELECT image_key, image_mime FROM ads WHERE id = $1 LIMIT 1',
    [adId],
  );
  const r = res.rows[0];
  if (!r || !r.image_key) return null;
  return { imageKey: r.image_key, imageMime: r.image_mime };
}

export async function handleImage(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  const adId = c.req.param('adId') ?? '';
  if (!isValidAdId(adId)) {
    return c.text('invalid ad id', 400);
  }

  // Cache lookup (Workers caches.default).
  const cacheKey = new Request(c.req.url, c.req.raw);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // DB lookup
  const meta = await withPgClient(c.env.POSTGRES_URL, (client) => getAdImage(client, adId));
  if (!meta) {
    return c.text('not found', 404);
  }

  // S3 fetch
  const s3 = createS3Client({
    endpoint: c.env.S3_ENDPOINT,
    region: c.env.S3_REGION,
    accessKeyId: c.env.S3_ACCESS_KEY_ID,
    secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
  });
  const obj = await getObject(s3, c.env.S3_BUCKET, meta.imageKey);
  if (!obj) {
    return c.text('not found', 404);
  }

  const headers = new Headers();
  const ct = obj.contentType ?? meta.imageMime ?? 'application/octet-stream';
  headers.set('Content-Type', ct);
  if (obj.contentLength !== undefined) headers.set('Content-Length', String(obj.contentLength));
  if (obj.etag) headers.set('ETag', obj.etag);
  headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);

  const response = new Response(obj.body, { status: 200, headers });

  // Edge cache: do not block the response.
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}
