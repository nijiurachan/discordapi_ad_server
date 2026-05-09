import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../../src/env.ts';
import { requireSiteKey } from '../../src/serve/site-key.ts';

function buildApp(env: Partial<Bindings>) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('/test', requireSiteKey);
  app.get('/test', (c) => c.text('ok'));
  return async (req: Request) => app.fetch(req, env as Bindings);
}

describe('requireSiteKey', () => {
  it('passes when SITE_API_KEY is unset', async () => {
    const fetch = buildApp({});
    const res = await fetch(new Request('http://x/test'));
    expect(res.status).toBe(200);
  });

  it('passes when header matches', async () => {
    const fetch = buildApp({ SITE_API_KEY: 'secret' });
    const res = await fetch(new Request('http://x/test', { headers: { 'X-Site-Key': 'secret' } }));
    expect(res.status).toBe(200);
  });

  it('401 when header is missing', async () => {
    const fetch = buildApp({ SITE_API_KEY: 'secret' });
    const res = await fetch(new Request('http://x/test'));
    expect(res.status).toBe(401);
  });

  it('401 when header mismatches', async () => {
    const fetch = buildApp({ SITE_API_KEY: 'secret' });
    const res = await fetch(new Request('http://x/test', { headers: { 'X-Site-Key': 'wrong' } }));
    expect(res.status).toBe(401);
  });
});
