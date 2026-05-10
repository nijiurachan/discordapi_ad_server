import type { PgClient } from '../db/client.ts';

const RETENTION_INTERVAL = '180 days';
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 1000; // hard ceiling: 1M rows per run

export type SweepAdEventsOptions = {
  batchSize?: number;
  maxBatches?: number;
};

export type SweepAdEventsResult = {
  batches: number;
  deleted: number;
  hitMaxBatches: boolean;
};

/**
 * Daily retention sweep for ad_events. Issued in fixed-size batches so
 * a long-running DELETE can't hold a lock for the entire window. The BRIN
 * index `ad_events_ts_idx` makes the inner SELECT cheap.
 *
 * Loops until a batch deletes 0 rows. We also cap the loop at maxBatches
 * (default 1000 = 1M rows) so a runaway insert spike can't keep us looping
 * forever inside a single cron tick — the next run picks up the rest.
 */
export async function sweepAdEvents(
  client: PgClient,
  options: SweepAdEventsOptions = {},
): Promise<SweepAdEventsResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;

  let batches = 0;
  let deleted = 0;
  while (batches < maxBatches) {
    const res = await client.query(
      `DELETE FROM ad_events
        WHERE id IN (
          SELECT id FROM ad_events
           WHERE ts < now() - interval '${RETENTION_INTERVAL}'
           LIMIT $1
        )`,
      [batchSize],
    );
    const n = res.rowCount ?? 0;
    if (n === 0) return { batches, deleted, hitMaxBatches: false };
    batches++;
    deleted += n;
  }
  return { batches, deleted, hitMaxBatches: true };
}
