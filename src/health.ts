import { Hono } from 'hono';
import type { Bindings } from './env.ts';
import { createPgClient } from './db/client.ts';

type HealthChecks = {
  db: string;
  s3?: string;
};

export const health = new Hono<{ Bindings: Bindings }>();

health.get('/', async (c) => {
  const checks: HealthChecks = { db: 'pending' };
  let overall: 'ok' | 'degraded' = 'ok';

  let db: ReturnType<typeof createPgClient> | undefined;
  try {
    db = createPgClient(c.env.POSTGRES_URL);
    await db.query('SELECT 1');
    checks.db = 'ok';
  } catch (err) {
    checks.db = err instanceof Error ? err.message : 'unknown error';
    overall = 'degraded';
  } finally {
    if (db) await db.end();
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
