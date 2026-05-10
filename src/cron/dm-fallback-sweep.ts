import type { PgClient } from '../db/client.ts';
import { writeAdminLog } from '../db/queries/admin-logs.ts';
import { type DiscordRest, DiscordRestError } from '../discord/rest.ts';

export type DmFallbackSweepResult = {
  selected: number;
  channelDeleted: number;
  channelGone: number;
  failed: number;
};

/**
 * Hourly sweep of expired+unacknowledged dm_fallback_channels rows.
 *
 * Per row:
 *   1. Discord DELETE /channels/<id>. 404 -> already gone, treated as success.
 *   2. Mark dm_fallback_channels.acknowledged_at = now() (records the sweep
 *      reaped it, distinguishing from sponsor-acknowledged rows).
 *   3. Set ads.dm_delivery_status = 'failed' so the spec's "DM never landed"
 *      state is reflected on the ad even after the fallback channel is gone.
 *   4. admin_logs row (actor 'system') for forensics.
 *
 * Other Discord errors are logged and the row is skipped — we'll retry next
 * hour. The partial index `dm_fallback_pending_idx` keeps the SELECT cheap.
 */
export async function sweepDmFallbackChannels(
  client: PgClient,
  rest: DiscordRest,
): Promise<DmFallbackSweepResult> {
  const sel = await client.query<{ id: string; channel_id: string; ad_id: string }>(
    `SELECT id, channel_id, ad_id
       FROM dm_fallback_channels
      WHERE acknowledged_at IS NULL
        AND expires_at < now()`,
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

    try {
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
    } catch (err) {
      failed++;
      console.error('dm-fallback-sweep: db update failed after channel cleanup', {
        rowId: row.id,
        err,
      });
    }
  }

  return { selected: sel.rows.length, channelDeleted, channelGone, failed };
}
