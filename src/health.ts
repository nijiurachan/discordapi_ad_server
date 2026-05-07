import { Hono } from 'hono';
import { createPgClient } from './db/client.ts';
import type { Bindings } from './env.ts';

export const health = new Hono<{ Bindings: Bindings }>();

health.get('/', async (c) => {
  const checks: { db: string } = { db: 'ok' };
  let overall: 'ok' | 'degraded' = 'ok';

  try {
    const db = createPgClient(c.env.POSTGRES_URL);
    await db.query('SELECT 1');
    await db.end();
    checks.db = 'ok';
  } catch (err) {
    checks.db = err instanceof Error ? err.message : 'unknown error';
    overall = 'degraded';
  }

  return c.json(
    {
      status: overall,
      service: 'discordapi_ad_server',
      time: new Date().toISOString(),
      checks,
    },
    overall === 'ok' ? 200 : 503,
  );
});
