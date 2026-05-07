import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { createPgClient } from './db/client.ts';
import type { Bindings } from './env.ts';
import { createS3Client } from './storage/s3.ts';

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

  try {
    const s3 = createS3Client({
      endpoint: c.env.S3_ENDPOINT,
      region: c.env.S3_REGION,
      accessKeyId: c.env.S3_ACCESS_KEY_ID,
      secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
    });
    await s3.send(new HeadBucketCommand({ Bucket: c.env.S3_BUCKET }));
    checks.s3 = 'ok';
  } catch (err) {
    checks.s3 = err instanceof Error ? err.message : 'unknown error';
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
