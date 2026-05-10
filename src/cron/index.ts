import type { Bindings } from '../env.ts';

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

async function runHourly(_env: Bindings): Promise<void> {
  // Filled in by P7.1 / P7.2 / P7.3.
}

async function runDaily(_env: Bindings): Promise<void> {
  // Filled in by P7.4 / P7.5 / P7.6.
}
