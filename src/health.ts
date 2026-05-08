import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { withPgClient } from './db/client.ts';
import type { Bindings } from './env.ts';
import { createS3Client } from './storage/s3.ts';

type HealthChecks = {
  db: string;
  s3?: string;
};

const PROBE_TIMEOUT_MS = 2000;

export const health = new Hono<{ Bindings: Bindings }>();

health.get('/', async (c) => {
  const checks: HealthChecks = { db: 'pending' };
  let overall: 'ok' | 'degraded' = 'ok';

  // DB probe: pg.Pool's connectionTimeoutMillis + query_timeout cancel at the
  // driver level so a hung connection cannot leak past the response.
  try {
    await withPgClient(c.env.POSTGRES_URL, (db) => db.query('SELECT 1'));
    checks.db = 'ok';
  } catch (err) {
    console.error('health: db probe failed', err);
    checks.db = 'unavailable';
    overall = 'degraded';
  }

  // S3 probe: pass an AbortSignal so the AWS SDK aborts the in-flight HTTP
  // request when the timeout fires (not just rejects a wrapper promise).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const s3 = createS3Client({
      endpoint: c.env.S3_ENDPOINT,
      region: c.env.S3_REGION,
      accessKeyId: c.env.S3_ACCESS_KEY_ID,
      secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
    });
    await s3.send(new HeadBucketCommand({ Bucket: c.env.S3_BUCKET }), {
      abortSignal: ctrl.signal,
    });
    checks.s3 = 'ok';
  } catch (err) {
    console.error('health: s3 probe failed', err);
    checks.s3 = 'unavailable';
    overall = 'degraded';
  } finally {
    clearTimeout(timer);
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
