import { withPgClient } from '../db/client.ts';
import { createDiscordRest } from '../discord/rest.ts';
import type { Bindings } from '../env.ts';
import { createS3Client } from '../storage/s3.ts';
import { sweepDmFallbackChannels } from './dm-fallback-sweep.ts';
import { expireAds } from './expire-ads.ts';
import { rotateDailySalt } from './rotate-salt.ts';
import { sweepAdEvents } from './sweep-ad-events.ts';
import { sweepExpiredDrafts } from './sweep-drafts.ts';

export const HOURLY_CRON = '0 * * * *';
export const DAILY_CRON = '0 0 * * *';

/**
 * Single dispatch entry called from the Worker `scheduled` handler.
 * Branches on `event.cron` so the wrangler.toml triggers act as a router:
 *   - "0 * * * *" -> hourly maintenance jobs
 *   - "0 0 * * *" -> daily maintenance jobs
 *
 * Each task is intentionally awaited inside the dispatch (rather than
 * `Promise.allSettled`) so logs interleave deterministically and a single
 * task's exception cannot silently mask another. Workers Cron retries
 * the schedule on throw, which is what we want.
 */
export async function dispatchCron(
  event: ScheduledController,
  env: Bindings,
  _ctx: ExecutionContext,
): Promise<void> {
  const cron = event.cron;
  if (cron === HOURLY_CRON) {
    await runHourly(env);
    return;
  }
  if (cron === DAILY_CRON) {
    await runDaily(env);
    return;
  }
  console.warn('cron: unrecognized schedule, ignoring', { cron });
}

async function runHourly(env: Bindings): Promise<void> {
  await runSafely('sweep-drafts', async () => {
    const s3 = createS3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
    const result = await withPgClient(env.POSTGRES_URL, (client) =>
      sweepExpiredDrafts(client, s3, env.S3_BUCKET),
    );
    console.log('cron.hourly.sweep-drafts', result);
  });

  await runSafely('expire-ads', async () => {
    const result = await withPgClient(env.POSTGRES_URL, (client) => expireAds(client));
    console.log('cron.hourly.expire-ads', result);
  });

  await runSafely('dm-fallback-sweep', async () => {
    const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
    const result = await withPgClient(env.POSTGRES_URL, (client) =>
      sweepDmFallbackChannels(client, rest),
    );
    console.log('cron.hourly.dm-fallback-sweep', result);
  });
}

async function runDaily(env: Bindings): Promise<void> {
  await runSafely('rotate-salt', async () => {
    const result = await withPgClient(env.POSTGRES_URL, (client) => rotateDailySalt(client));
    console.log('cron.daily.rotate-salt', result);
  });

  await runSafely('sweep-ad-events', async () => {
    const result = await withPgClient(env.POSTGRES_URL, (client) => sweepAdEvents(client));
    console.log('cron.daily.sweep-ad-events', result);
  });
}

/**
 * Run a single cron task and contain its failure. We log but do not rethrow
 * so one failing task cannot mask the rest of the schedule's work; the
 * outer dispatch only rethrows on truly unexpected errors.
 */
async function runSafely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`cron task failed: ${name}`, err);
  }
}
