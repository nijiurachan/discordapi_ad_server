import type { PgClient } from '../../db/client.ts';
import {
  closePortalRow,
  createPortalRow,
  findOpenPortalBySponsor,
} from '../../db/queries/portal.ts';
import { buildPortalOverwrites } from '../../discord/permissions.ts';
import { type DiscordRest, DiscordRestError } from '../../discord/rest.ts';

export type OpenPortalArgs = {
  client: PgClient;
  rest: DiscordRest;
  guildId: string;
  botId: string;
  categoryId: string;
  sponsorId: string;
  reviewerRoleId: string;
  adminRoleId: string;
  uuid: () => string;
};

export type OpenPortalResult =
  | {
      ok: true;
      portalId: string;
      channelId: string;
      dashboardMessageId: string | null;
      reusedExisting: boolean;
    }
  | { ok: false; reason: 'rest_error' | 'db_error'; error: unknown };

/**
 * Find-or-create the sponsor's private portal channel. Mirrors
 * createOrReuseFallbackChannel's insert-first + compensating-cleanup ordering,
 * plus getChannel-404 self-heal: a reused row whose Discord channel is gone is
 * archived and recreated.
 */
export async function openOrReusePortalChannel(args: OpenPortalArgs): Promise<OpenPortalResult> {
  // 1. Reuse path.
  const existing = await findOpenPortalBySponsor(args.client, args.sponsorId);
  if (existing) {
    try {
      await args.rest.getChannel(existing.channelId);
      return {
        ok: true,
        portalId: existing.id,
        channelId: existing.channelId,
        dashboardMessageId: existing.dashboardMessageId,
        reusedExisting: true,
      };
    } catch (err) {
      if (err instanceof DiscordRestError && err.status === 404) {
        // Self-heal: channel manually deleted. Archive the orphan row so the
        // partial unique index frees up, then fall through to create fresh.
        try {
          await closePortalRow(args.client, existing.id);
        } catch (closeErr) {
          console.error('portal: self-heal closePortalRow failed', {
            portalId: existing.id,
            closeErr,
          });
          return { ok: false, reason: 'db_error', error: closeErr };
        }
      } else {
        console.error('portal: getChannel failed', { channelId: existing.channelId, err });
        return { ok: false, reason: 'rest_error', error: err };
      }
    }
  }

  // 2. Create path. Row first (channel_id starts as a placeholder = the
  // portalId) so the UNIQUE(sponsor_id) partial index serializes double-clicks
  // before any Discord side effect.
  const portalId = args.uuid();
  try {
    await createPortalRow(args.client, {
      id: portalId,
      sponsorId: args.sponsorId,
      channelId: portalId,
    });
  } catch (err) {
    console.error('portal: createPortalRow failed (likely double-click)', {
      sponsorId: args.sponsorId,
      err,
    });
    return { ok: false, reason: 'db_error', error: err };
  }

  // 3. Create the Discord channel.
  let channelId: string;
  try {
    const ch = await args.rest.createGuildChannel(args.guildId, {
      name: `portal-${args.sponsorId.slice(0, 12)}`,
      type: 0,
      parent_id: args.categoryId,
      permission_overwrites: buildPortalOverwrites({
        guildId: args.guildId,
        sponsorId: args.sponsorId,
        botId: args.botId,
        reviewerRoleId: args.reviewerRoleId,
        adminRoleId: args.adminRoleId,
      }),
      topic: '広告ポータル（プラン・残予算・出稿中バナーの確認 / アイドルで自動削除）',
    });
    channelId = ch.id;
  } catch (err) {
    console.error('portal: createGuildChannel failed; rolling back row', {
      portalId,
      err,
    });
    try {
      await args.client.query('DELETE FROM portal_channels WHERE id = ?', [portalId]);
    } catch (delErr) {
      console.error('portal: rollback DELETE failed', { portalId, delErr });
    }
    return { ok: false, reason: 'rest_error', error: err };
  }

  // 4. Point the row at the real channel id.
  try {
    await args.client.query('UPDATE portal_channels SET channel_id = ? WHERE id = ?', [
      channelId,
      portalId,
    ]);
  } catch (err) {
    console.error('portal: channel_id UPDATE failed; deleting orphan channel', {
      portalId,
      channelId,
      err,
    });
    try {
      await args.rest.deleteChannel(channelId);
    } catch (delErr) {
      console.error('portal: orphan channel delete failed', { channelId, delErr });
    }
    try {
      await args.client.query('DELETE FROM portal_channels WHERE id = ?', [portalId]);
    } catch (rowErr) {
      console.error('portal: orphan row delete failed', { portalId, rowErr });
    }
    return { ok: false, reason: 'db_error', error: err };
  }

  return {
    ok: true,
    portalId,
    channelId,
    dashboardMessageId: null,
    reusedExisting: false,
  };
}
