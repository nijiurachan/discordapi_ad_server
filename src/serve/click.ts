import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../db/client.ts';
import type { Bindings } from '../env.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAdId(adId: string): boolean {
  return UUID_RE.test(adId);
}

export async function getAdLinkUrl(client: PgClient, adId: string): Promise<string | null> {
  const res = await client.query<{ link_url: string }>(
    'SELECT link_url FROM ads WHERE id = $1 LIMIT 1',
    [adId],
  );
  return res.rows[0]?.link_url ?? null;
}

export async function handleClick(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  const adId = c.req.param('adId') ?? '';
  if (!isValidAdId(adId)) {
    return c.text('invalid ad id', 400);
  }

  const linkUrl = await withPgClient(c.env.POSTGRES_URL, (client) => getAdLinkUrl(client, adId));
  if (!linkUrl) {
    return c.text('not found', 404);
  }

  // Server-side redirect to the persisted link_url. Any client-supplied query
  // (e.g., ?to=) is intentionally ignored to prevent open-redirect attacks.
  return c.redirect(linkUrl, 302);
}
