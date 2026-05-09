import type { PgClient } from '../../db/client.ts';
import {
  type ResultDmAdInfo,
  buildApproveDmEmbed,
  buildRejectDmEmbed,
} from '../../discord/embeds/result-dm.ts';
import { type DiscordRest, DiscordRestError } from '../../discord/rest.ts';

export type DmSendResult =
  | { ok: true; channelId: string; messageId: string }
  | { ok: false; reason: 'blocked' | 'no_sponsor' | 'rest_error'; status?: number };

export async function setDmDeliveryStatus(
  client: PgClient,
  adId: string,
  status: 'sent' | 'failed' | 'fallback_posted' | 'fallback_acknowledged',
  deliveredAt?: Date | null,
): Promise<void> {
  await client.query(
    `UPDATE ads
        SET dm_delivery_status = $1,
            dm_delivered_at    = $2
      WHERE id = $3`,
    [status, deliveredAt ?? null, adId],
  );
}

export type SendResultDmArgs = {
  rest: DiscordRest;
  client: PgClient;
  ad: ResultDmAdInfo;
  sponsorId: string | null;
  action: 'approved' | 'rejected';
  reason?: string;
};

/**
 * Send the result DM (approve/reject) to the sponsor.
 * - On 200: set dm_delivery_status='sent', dm_delivered_at=now()
 * - On 403 (DM disabled): set dm_delivery_status='failed', return { ok: false, reason: 'blocked' }
 *   so the caller can trigger the fallback channel flow (P3.5)
 * - For house/placeholder ads (sponsorId null): skip and return { ok: false, reason: 'no_sponsor' }
 */
export async function sendResultDM(args: SendResultDmArgs): Promise<DmSendResult> {
  if (!args.sponsorId) {
    return { ok: false, reason: 'no_sponsor' };
  }

  const embed =
    args.action === 'approved'
      ? buildApproveDmEmbed(args.ad)
      : buildRejectDmEmbed(args.ad, args.reason ?? '理由は記載されていません。');

  let channelId: string;
  try {
    const ch = await args.rest.createDmChannel(args.sponsorId);
    channelId = ch.id;
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 403) {
      await setDmDeliveryStatus(args.client, args.ad.id, 'failed');
      return { ok: false, reason: 'blocked', status: 403 };
    }
    console.error('sendResultDM: createDmChannel failed', { adId: args.ad.id, err });
    return { ok: false, reason: 'rest_error' };
  }

  try {
    const msg = await args.rest.createMessage(channelId, { embeds: [embed] });
    await setDmDeliveryStatus(args.client, args.ad.id, 'sent', new Date());
    return { ok: true, channelId, messageId: msg.id };
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 403) {
      await setDmDeliveryStatus(args.client, args.ad.id, 'failed');
      return { ok: false, reason: 'blocked', status: 403 };
    }
    console.error('sendResultDM: createMessage failed', { adId: args.ad.id, err });
    return { ok: false, reason: 'rest_error' };
  }
}
