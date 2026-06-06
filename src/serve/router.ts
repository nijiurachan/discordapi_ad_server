import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { withPgClient } from '../db/client.ts';
import { insertEventIfNotRecent } from '../db/queries/ad-events.ts';
import type { Bindings } from '../env.ts';
import { shouldRecordEvent } from '../utils/event-filter.ts';
import { hashIP } from '../utils/ip-hash.ts';
import { getDailySalt } from '../utils/salt.ts';
import { handleClick } from './click.ts';
import { type ServedAd, serveAds } from './pick.ts';
import { clickRateLimit, serveRateLimit } from './rate-limit.ts';
import { requireSiteKey } from './site-key.ts';
import { generateImpressionToken } from './token.ts';

export const serveRouter = new Hono<{ Bindings: Bindings }>();

// CORS for /ads/serve so third-party sites can fetch the ad directly from the
// browser. The response is intentionally public delivery data (image_url,
// click_url, impression_token) — nothing sensitive — so Allow-Origin: * is
// safe. Site-key, if set, is exchanged via a custom header that requires
// preflight; handle OPTIONS explicitly here.
const serveCors = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'X-Site-Key, Content-Type, Accept');
  c.header('Access-Control-Max-Age', '600');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return next();
});

// /ads/serve: CORS first (so 204 preflight returns before auth), then optional
// site-key validation + per-IP rate limit (60/min).
serveRouter.use('/serve', serveCors, requireSiteKey, serveRateLimit);
// /ads/click/:adId: per-IP+adId rate limit (10/min). No site key (clicks come from third-party HTML).
serveRouter.use('/click/:adId', clickRateLimit);

const MAX_N = 5;

export function parseN(raw: string | undefined): number {
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, MAX_N);
}

/**
 * Build the public image URL for direct (non-proxied) delivery.
 * Joins S3_PUBLIC_BASE_URL with the stored image_key, normalizing the
 * boundary slash so a trailing slash on the base or a leading slash on
 * the key won't produce `//`. Returns null when the ad has no image.
 */
export function buildPublicImageUrl(baseUrl: string, imageKey: string | null): string | null {
  if (!imageKey) return null;
  return `${baseUrl.replace(/\/+$/, '')}/${imageKey.replace(/^\/+/, '')}`;
}

serveRouter.get('/serve', async (c) => {
  const slot = c.req.query('slot') ?? 'default';
  const n = parseN(c.req.query('n'));

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const ipHash = await hashIP(ip, c.env.IP_HASH_SALT_BOOTSTRAP);

  const ads = await withPgClient(c.env, (client) => serveAds(client, slot, n));
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
        image_url: buildPublicImageUrl(c.env.S3_PUBLIC_BASE_URL, ad.imageKey),
        // Omit click_url for ads without a destination link so frontends can
        // render the image without an <a> wrapper. Anchored ads still need it.
        click_url: ad.linkUrl ? `${c.env.WORKER_BASE_URL}/ads/click/${ad.id}` : null,
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

// Images are served directly from public object storage (S3_PUBLIC_BASE_URL);
// the Worker is intentionally not in the image path. See buildPublicImageUrl.
serveRouter.get('/click/:adId', handleClick);

// Minimal HTML demo so an integrator can eyeball the full flow end-to-end
// (image render → click redirect → 302 to ad.link_url). Uses /ads/serve under
// the hood, so it exercises the same code path as a real third-party embed
// would. Not behind site-key — public test page.
serveRouter.get('/demo', (c) => {
  // Strict allowlist: slot is interpolated into both HTML attributes and the
  // inline <script> body. Anything outside [A-Za-z0-9_-] (or longer than 64
  // chars) gets clamped to 'default' rather than escaped, since slot is also
  // matched server-side against the ad_format_rules table — exotic strings
  // can't resolve to a real slot anyway.
  const rawSlot = c.req.query('slot') ?? 'default';
  const slot = /^[A-Za-z0-9_-]{1,64}$/.test(rawSlot) ? rawSlot : 'default';
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>バナー広告デモ (slot=${slot})</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 32px auto; padding: 0 16px; line-height: 1.5; color: #1f2328; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .meta { color: #6e7781; font-size: 13px; margin-bottom: 24px; }
  .banner { display: inline-block; border: 1px solid #d0d7de; border-radius: 8px; padding: 8px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .banner img { display: block; max-width: 100%; height: auto; }
  .ad-meta { margin-top: 16px; padding: 12px; background: #f6f8fa; border-radius: 6px; font-size: 13px; }
  .ad-meta strong { color: #0969da; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; }
  .err { color: #cf222e; padding: 12px; border-left: 4px solid #cf222e; background: #ffebe9; }
  button { margin-top: 8px; padding: 6px 12px; border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; cursor: pointer; font-size: 13px; }
  button:hover { background: #eaeef2; }
</style>
</head>
<body>
<h1>📣 バナー広告デモ <small>(slot=<code>${slot}</code>)</small></h1>
<p class="meta">クライアント側で <code>/ads/serve?slot=${slot}&n=1</code> を叩いて画像を描画 → クリックで <code>/ads/click/{id}</code> 経由 302 リダイレクト。impression は配信時に自動計上、click はリダイレクト時に計上。</p>
<div id="root">読込中…</div>
<button onclick="location.reload()">🔄 リロード（別の広告を引きたい時）</button>
<script>
(async () => {
  const root = document.getElementById('root');
  // Helpers — no innerHTML with interpolated values anywhere. Title/body/etc
  // come from /ads/serve which echoes user-submitted Discord text; treat as
  // untrusted and route through textContent. Image / click URLs are
  // server-generated but we still check scheme defensively.
  const showError = (msg) => {
    root.replaceChildren();
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = msg;
    root.appendChild(p);
  };
  const safeHttpUrl = (raw) => {
    try {
      const u = new URL(raw, location.origin);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
    } catch { return ''; }
  };
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'className') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else node.setAttribute(k, props[k]);
    }
    for (const c of children) if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
  };

  try {
    const res = await fetch('/ads/serve?slot=${slot}&n=1', { headers: { 'accept': 'application/json' } });
    if (res.status === 204) { showError('配信対象の広告がありません (204)'); return; }
    if (!res.ok) { showError('/ads/serve エラー (' + res.status + ')'); return; }
    const data = await res.json();
    const ad = data.ads && data.ads[0];
    if (!ad) { showError('広告 0 件'); return; }

    const imgSrc = safeHttpUrl(ad.image_url);
    if (!imgSrc) { showError('URL スキーム不正 (https のみ受理)'); return; }
    // click_url is optional — when the sponsor submitted no link, the field
    // comes back null and we render just the image without an <a> wrapper.
    const clickHref = ad.click_url ? safeHttpUrl(ad.click_url) : '';

    const img = el('img', { alt: String(ad.title ?? '') });
    img.src = imgSrc;
    let banner;
    if (clickHref) {
      banner = el('a', { className: 'banner', target: '_blank', rel: 'noopener' }, img);
      banner.href = clickHref;
    } else {
      banner = el('div', { className: 'banner' }, img);
    }

    const metaDiv = el('div', { className: 'ad-meta' },
      el('div', null, el('strong', { text: String(ad.title ?? '') }), ' — ', String(ad.body ?? '')),
      el('div', null, 'kind: ', el('code', { text: String(ad.kind ?? '') }), ' / ad_id: ', el('code', { text: String(ad.id ?? '') })),
      el('div', null, 'click_url: ', el('code', { text: clickHref || '(なし — リンクなし広告)' })),
    );

    const details = el('details', { style: 'margin-top:16px' },
      el('summary', { text: 'レスポンス全文' }),
      el('pre', { text: JSON.stringify(data, null, 2) }),
    );

    root.replaceChildren(banner, metaDiv, details);
  } catch (e) {
    showError('fetch 失敗: ' + (e && e.message ? e.message : String(e)));
  }
})();
</script>
</body>
</html>`;
  return c.html(html);
});

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
    await withPgClient(env, async (client) => {
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
