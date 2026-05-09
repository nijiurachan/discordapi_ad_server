import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env.ts';
import { clickRateLimit, serveRateLimit } from '../../src/serve/rate-limit.ts';

function buildApp(env: Partial<Bindings>, variant: 'serve' | 'click') {
  const app = new Hono<{ Bindings: Bindings }>();
  if (variant === 'serve') {
    app.use('/serve', serveRateLimit);
    app.get('/serve', (c) => c.text('ok'));
  } else {
    app.use('/click/:adId', clickRateLimit);
    app.get('/click/:adId', (c) => c.text('ok'));
  }
  return async (req: Request) => app.fetch(req, env as Bindings);
}

describe('serveRateLimit', () => {
  it('200 when limiter allows', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const fetch = buildApp({ SERVE_RATE_LIMITER: { limit } }, 'serve');
    const res = await fetch(
      new Request('http://x/serve', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
    );
    expect(res.status).toBe(200);
    expect(limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  });

  it('429 when limiter denies', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const fetch = buildApp({ SERVE_RATE_LIMITER: { limit } }, 'serve');
    const res = await fetch(new Request('http://x/serve'));
    expect(res.status).toBe(429);
  });

  it('uses "unknown" when cf-connecting-ip header absent', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const fetch = buildApp({ SERVE_RATE_LIMITER: { limit } }, 'serve');
    const res = await fetch(new Request('http://x/serve'));
    expect(res.status).toBe(200);
    expect(limit).toHaveBeenCalledWith({ key: 'unknown' });
  });
});

describe('clickRateLimit', () => {
  it('keys by IP+adId', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const fetch = buildApp({ CLICK_RATE_LIMITER: { limit } }, 'click');
    const res = await fetch(
      new Request('http://x/click/abc-123', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
    );
    expect(res.status).toBe(200);
    expect(limit).toHaveBeenCalledWith({ key: '1.2.3.4|abc-123' });
  });

  it('429 when click limiter denies', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const fetch = buildApp({ CLICK_RATE_LIMITER: { limit } }, 'click');
    const res = await fetch(new Request('http://x/click/abc-123'));
    expect(res.status).toBe(429);
  });
});
