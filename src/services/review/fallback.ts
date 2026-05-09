import type { PgClient } from '../../db/client.ts';
import {
  createFallbackRow,
  findActiveFallback,
  markFallbackAcknowledged,
} from '../../db/queries/fallback.ts';
import {
  type ResultDmAdInfo,
  buildApproveDmEmbed,
  buildRejectDmEmbed,
} from '../../discord/embeds/result-dm.ts';
import { buildFallbackOverwrites } from '../../discord/permissions.ts';
import type { DiscordRest } from '../../discord/rest.ts';
import { setDmDeliveryStatus } from './dm.ts';

const FALLBACK_TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CreateFallbackArgs = {
  rest: DiscordRest;
  client: PgClient;
  guildId: string;
  botId: string;
  categoryId: string;
  ad: ResultDmAdInfo;
  sponsorId: string;
  action: 'approved' | 'rejected';
  reason?: string;
  uuid: () => string;
};

export type CreateFallbackResult =
  | {
      ok: true;
      fallbackId: string;
      channelId: string;
      messageId: string;
      reusedExisting: boolean;
    }
  | { ok: false; reason: 'rest_error'; error: unknown };

function buildAckButtonRow(fallbackId: string): Record<string, unknown> {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 3, // SUCCESS (green)
        custom_id: `ack:${fallbackId}`,
        label: '✅ 了解',
      },
    ],
  };
}

/**
 * Create a private fallback channel for sponsors who have DM disabled, or
 * append a new message to an existing active fallback channel for the same ad.
 *
 * Caller MUST ensure `sponsorId` is non-null (house/placeholder ads should
 * never reach this service).
 *
 * Behavior:
 *  - If a fallback row exists for this ad with `acknowledged_at IS NULL` and
 *    `expires_at > now()`, append a new message to its channel and return
 *    `reusedExisting: true`. No new INSERT, no `dm_delivery_status` UPDATE
 *    (it should already be 'fallback_posted').
 *  - Otherwise create a new private guild channel under `categoryId`, INSERT
 *    a `dm_fallback_channels` row, post the result Embed + 了解 button, and
 *    UPDATE `ads.dm_delivery_status='fallback_posted'`.
 */
export async function createOrReuseFallbackChannel(
  args: CreateFallbackArgs,
): Promise<CreateFallbackResult> {
  const embed =
    args.action === 'approved'
      ? buildApproveDmEmbed(args.ad)
      : buildRejectDmEmbed(args.ad, args.reason ?? '理由は記載されていません。');

  // Check for an active fallback for the same ad
  const existing = await findActiveFallback(args.client, args.ad.id);
  if (existing) {
    try {
      const msg = await args.rest.createMessage(existing.channelId, {
        content: `<@${args.sponsorId}> 審査結果通知です（追加投稿）`,
        embeds: [embed],
        components: [buildAckButtonRow(existing.id)],
      });
      // Don't change dm_delivery_status here; it should already be 'fallback_posted'.
      return {
        ok: true,
        fallbackId: existing.id,
        channelId: existing.channelId,
        messageId: msg.id,
        reusedExisting: true,
      };
    } catch (err) {
      console.error('fallback: append message failed', { adId: args.ad.id, err });
      return { ok: false, reason: 'rest_error', error: err };
    }
  }

  // Create new private channel
  const fallbackId = args.uuid();
  const channelName = `result-${args.ad.id.slice(0, 8)}`;
  const overwrites = buildFallbackOverwrites({
    guildId: args.guildId,
    sponsorId: args.sponsorId,
    botId: args.botId,
  });

  let channelId: string;
  try {
    const ch = await args.rest.createGuildChannel(args.guildId, {
      name: channelName,
      type: 0,
      parent_id: args.categoryId,
      permission_overwrites: overwrites,
      topic: '個別通知（このチャンネルは「了解」ボタン押下または7日後に自動削除されます）',
    });
    channelId = ch.id;
  } catch (err) {
    console.error('fallback: createGuildChannel failed', { adId: args.ad.id, err });
    return { ok: false, reason: 'rest_error', error: err };
  }

  // Persist row before posting message — if message post fails, the cron
  // sweep (P7) will still clean up the orphaned channel via TTL.
  const expiresAt = new Date(Date.now() + FALLBACK_TTL_DAYS * MS_PER_DAY);
  try {
    await createFallbackRow(args.client, {
      id: fallbackId,
      adId: args.ad.id,
      sponsorId: args.sponsorId,
      channelId,
      expiresAt,
    });
  } catch (err) {
    console.error('fallback: createFallbackRow failed; cleaning up channel', {
      adId: args.ad.id,
      channelId,
      err,
    });
    try {
      await args.rest.deleteChannel(channelId);
    } catch (delErr) {
      console.error('fallback: rollback deleteChannel failed', { channelId, delErr });
    }
    return { ok: false, reason: 'rest_error', error: err };
  }

  // Post the result Embed + ack button
  let messageId: string;
  try {
    const msg = await args.rest.createMessage(channelId, {
      content: `<@${args.sponsorId}> 審査結果通知です（DM がオフのためこちらに送信しました）`,
      embeds: [embed],
      components: [buildAckButtonRow(fallbackId)],
    });
    messageId = msg.id;
  } catch (err) {
    console.error('fallback: createMessage failed', {
      adId: args.ad.id,
      channelId,
      err,
    });
    // Compensating cleanup: mark the row acknowledged so it doesn't block
    // future submits, and delete the empty channel.
    try {
      await markFallbackAcknowledged(args.client, fallbackId);
    } catch (mErr) {
      console.error('fallback: cleanup mark failed', { fallbackId, mErr });
    }
    try {
      await args.rest.deleteChannel(channelId);
    } catch (dErr) {
      console.error('fallback: cleanup deleteChannel failed', { channelId, dErr });
    }
    return { ok: false, reason: 'rest_error', error: err };
  }

  // Update ads.dm_delivery_status='fallback_posted'
  await setDmDeliveryStatus(args.client, args.ad.id, 'fallback_posted');

  return { ok: true, fallbackId, channelId, messageId, reusedExisting: false };
}
