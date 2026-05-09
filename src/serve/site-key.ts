import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../env.ts';
import { timingSafeEqualStrings } from '../utils/timing-safe.ts';

/**
 * Optional site-key validation for /ads/serve.
 * - When SITE_API_KEY is unset (production may leave empty), the check is skipped.
 * - When set, requests must include a matching X-Site-Key header.
 */
export const requireSiteKey = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const expected = c.env.SITE_API_KEY;
  if (!expected) return next();
  const provided = c.req.header('X-Site-Key');
  if (!timingSafeEqualStrings(provided, expected)) {
    return c.json({ error: 'invalid site key' }, 401);
  }
  return next();
});
