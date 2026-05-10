import type { PgClient } from '../db/client.ts';
import { writeAdminLog } from '../db/queries/admin-logs.ts';
import { type DiscordRest, DiscordRestError } from '../discord/rest.ts';

export type DmFallbackSweepResult = {
  selected: number;
  channelDeleted: number;
  channelGone: number;
  failed: number;
};

const BATCH_LIMIT = 100;

/**
 * Hourly sweep of expired+unacknowledged dm_fallback_channels rows.
 *
 * Per row:
 *   1. Discord DELETE /channels/<id>. 404 -> already gone, treated as success.
 *   2. Inside a single transaction: mark acknowledged_at, set
 *      ads.dm_delivery_status='failed' (only if not in a positive terminal
 *      state), write admin_logs. Atomicity matters because the partial index
 *      `dm_fallback_pending_idx` filters on acknowledged_at IS NULL — if the
 *      ack landed but the ads UPDATE / admin_logs INSERT failed, the row
 *      would be permanently invisible to the next sweep with no audit trail.
 *      A failure now rolls everything back so the next hour retries cleanly.
 *
 * Other Discord errors are logged and the row is skipped — we'll retry next
 * hour. SELECT is bounded by BATCH_LIMIT so a long backlog is processed across
 * cron ticks instead of one over-long invocation.
 */
export async function sweepDmFallbackChannels(
  client: PgClient,
  rest: DiscordRest,
): Promise<DmFallbackSweepResult> {
  const sel = await client.query<{ id: string; channel_id: string; ad_id: string }>(
    `SELECT id, channel_id, ad_id
       FROM dm_fallback_channels
      WHERE acknowledged_at IS NULL
        AND expires_at < now()
      LIMIT $1`,
    [BATCH_LIMIT],
  );

  let channelDeleted = 0;
  let channelGone = 0;
  let failed = 0;

  for (const row of sel.rows) {
    try {
      await rest.deleteChannel(row.channel_id);
      channelDeleted++;
    } catch (err) {
      if (err instanceof DiscordRestError && err.status === 404) {
        channelGone++;
      } else {
        failed++;
        console.error('dm-fallback-sweep: deleteChannel failed', {
          rowId: row.id,
          channelId: row.channel_id,
          err,
        });
        continue;
      }
    }

    let txOpen = false;
    try {
      await client.query('BEGIN');
      txOpen = true;
      await client.query('UPDATE dm_fallback_channels SET acknowledged_at = now() WHERE id = $1', [
        row.id,
      ]);
      await client.query(
        `UPDATE ads
            SET dm_delivery_status = 'failed'
          WHERE id = $1
            AND (dm_delivery_status IS NULL OR dm_delivery_status NOT IN ('sent', 'fallback_acknowledged'))`,
        [row.ad_id],
      );
      await writeAdminLog(client, {
        actorId: 'system',
        action: 'dm_fallback_sweep',
        targetKind: 'dm_fallback_channel',
        targetId: row.id,
        after: { channel_id: row.channel_id, ad_id: row.ad_id },
      });
      await client.query('COMMIT');
      txOpen = false;
    } catch (err) {
      failed++;
      console.error('dm-fallback-sweep: db update failed after channel cleanup', {
        rowId: row.id,
        err,
      });
      if (txOpen) {
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          console.error('dm-fallback-sweep: rollback failed', { rowId: row.id, rbErr });
        }
      }
    }
  }

  return { selected: sel.rows.length, channelDeleted, channelGone, failed };
}
