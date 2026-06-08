import type { PgClient } from '../db/client.ts';
import { type DiscordRest, DiscordRestError } from '../discord/rest.ts';

export type PortalSweepResult = {
  selected: number;
  channelDeleted: number;
  channelGone: number;
  failed: number;
};

const BATCH_LIMIT = 100;
// Idle TTL: portals untouched for 24h are reclaimed. Recreate-on-demand makes
// this cheap — the sponsor just presses "広告ポータルを開く" again.
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hourly idle sweep of portal_channels. Per row: Discord DELETE (404 == gone,
 * treated as success), then archive the row. Non-404 Discord errors skip the
 * row (retried next hour) so we never leave a dangling channel un-archived.
 * Bounded by BATCH_LIMIT so a backlog drains across ticks.
 */
export async function sweepPortalChannels(
  client: PgClient,
  rest: DiscordRest,
): Promise<PortalSweepResult> {
  const sel = await client.query<{ id: string; channel_id: string }>(
    `SELECT id, channel_id
       FROM portal_channels
      WHERE archived_at IS NULL
        AND last_active_at < (unixepoch() * 1000) - ?
      LIMIT ?`,
    [IDLE_TTL_MS, BATCH_LIMIT],
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
        console.error('portal-sweep: deleteChannel failed', {
          rowId: row.id,
          channelId: row.channel_id,
          err,
        });
        continue;
      }
    }
    try {
      await client.query(
        'UPDATE portal_channels SET archived_at = (unixepoch() * 1000) WHERE id = ? AND archived_at IS NULL',
        [row.id],
      );
    } catch (err) {
      failed++;
      console.error('portal-sweep: archive UPDATE failed after channel cleanup', {
        rowId: row.id,
        err,
      });
    }
  }

  return { selected: sel.rows.length, channelDeleted, channelGone, failed };
}
