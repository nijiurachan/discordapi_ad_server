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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

export const health = new Hono<{ Bindings: Bindings }>();

health.get('/', async (c) => {
  const checks: HealthChecks = { db: 'pending' };
  let overall: 'ok' | 'degraded' = 'ok';

  try {
    await withTimeout(
      withPgClient(c.env.POSTGRES_URL, (db) => db.query('SELECT 1')),
      PROBE_TIMEOUT_MS,
      'db probe',
    );
    checks.db = 'ok';
  } catch (err) {
    console.error('health: db probe failed', err);
    checks.db = 'unavailable';
    overall = 'degraded';
  }

  try {
    const s3 = createS3Client({
      endpoint: c.env.S3_ENDPOINT,
      region: c.env.S3_REGION,
      accessKeyId: c.env.S3_ACCESS_KEY_ID,
      secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
    });
    await withTimeout(
      s3.send(new HeadBucketCommand({ Bucket: c.env.S3_BUCKET })),
      PROBE_TIMEOUT_MS,
      's3 probe',
    );
    checks.s3 = 'ok';
  } catch (err) {
    console.error('health: s3 probe failed', err);
    checks.s3 = 'unavailable';
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
