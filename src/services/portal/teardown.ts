import type { PgClient } from '../../db/client.ts';
import { closePortalRow, findPortalById } from '../../db/queries/portal.ts';
import { type DiscordRest, DiscordRestError } from '../../discord/rest.ts';

export type ClosePortalResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_owner' };

/**
 * Owner-checked teardown: archive the row (atomic, only-while-active), then
 * best-effort delete the channel. A 404 on delete is fine — the cron sweep or
 * a manual delete may have raced us.
 */
export async function closePortal(args: {
  client: PgClient;
  rest: DiscordRest;
  portalId: string;
  userId: string;
}): Promise<ClosePortalResult> {
  const row = await findPortalById(args.client, args.portalId);
  if (!row || row.archivedAt) return { ok: false, reason: 'not_found' };
  if (row.sponsorId !== args.userId) return { ok: false, reason: 'not_owner' };

  await closePortalRow(args.client, args.portalId);

  try {
    await args.rest.deleteChannel(row.channelId);
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 404) {
      console.warn('portal close: channel already deleted', { channelId: row.channelId });
    } else {
      console.error('portal close: deleteChannel failed', { channelId: row.channelId, err });
    }
  }
  return { ok: true };
}
