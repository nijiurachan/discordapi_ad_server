import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../db/client.ts';
import { insertEventIfNotRecent } from '../db/queries/ad-events.ts';
import type { Bindings } from '../env.ts';
import { shouldRecordEvent } from '../utils/event-filter.ts';
import { hashIP } from '../utils/ip-hash.ts';
import { getDailySalt } from '../utils/salt.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AdRedirectInfo = {
  linkUrl: string;
  kind: 'regular' | 'house' | 'placeholder';
};

export function isValidAdId(adId: string): boolean {
  return UUID_RE.test(adId);
}

export async function getAdLinkUrl(client: PgClient, adId: string): Promise<AdRedirectInfo | null> {
  const res = await client.query<{ link_url: string; kind: string }>(
    'SELECT link_url, kind FROM ads WHERE id = $1 LIMIT 1',
    [adId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { linkUrl: row.link_url, kind: row.kind as AdRedirectInfo['kind'] };
}

export async function handleClick(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  const adId = c.req.param('adId') ?? '';
  if (!isValidAdId(adId)) {
    return c.text('invalid ad id', 400);
  }

  const result = await withPgClient(c.env.POSTGRES_URL, async (client) => {
    const ad = await getAdLinkUrl(client, adId);
    if (!ad) return null;

    // Best-effort tracking — failures must not block the redirect.
    const method = c.req.method;
    const ua = c.req.header('user-agent') ?? null;
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    if (
      ad.kind !== 'placeholder' && // placeholder click excluded from analytics (spec §5.6)
      shouldRecordEvent({ method, ua })
    ) {
      try {
        const salt = await getDailySalt(client, c.env.IP_HASH_SALT_BOOTSTRAP);
        const ipHash = await hashIP(ip, salt);
        await insertEventIfNotRecent(client, {
          adId,
          eventType: 'click',
          ipHash,
          ua,
          slot: null,
        });
        // We don't branch on the result — best-effort.
      } catch (err) {
        console.warn('click: tracking failed (continuing redirect)', { adId, err });
      }
    }

    return ad;
  });

  if (!result) {
    return c.text('not found', 404);
  }

  // Server-side redirect to the persisted link_url. Any client-supplied query
  // (e.g., ?to=) is intentionally ignored to prevent open-redirect attacks.
  return c.redirect(result.linkUrl, 302);
}
