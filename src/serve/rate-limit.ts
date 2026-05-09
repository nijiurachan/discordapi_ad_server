import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../env.ts';

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

/**
 * Rate-limits /ads/serve by client IP. Limit configured in wrangler.toml (60/min).
 */
export const serveRateLimit = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const ip = clientIp(c);
  const result = await c.env.SERVE_RATE_LIMITER.limit({ key: ip });
  if (!result.success) {
    return c.json({ error: 'rate limit exceeded' }, 429);
  }
  return next();
});

/**
 * Rate-limits /ads/click/:adId by IP+adId. Limit configured in wrangler.toml (10/min/IP+adId).
 */
export const clickRateLimit = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const ip = clientIp(c);
  const adId = c.req.param('adId') ?? 'unknown';
  const result = await c.env.CLICK_RATE_LIMITER.limit({ key: `${ip}|${adId}` });
  if (!result.success) {
    return c.json({ error: 'rate limit exceeded' }, 429);
  }
  return next();
});
