import type { PgClient } from '../../db/client.ts';
import {
  type AdSnapshot,
  forceEndAd as forceEndAdRow,
  getAdById,
  updateAdStatus,
} from '../../db/queries/ad-actions.ts';
import { writeAdminLog } from '../../db/queries/admin-logs.ts';
import type { DiscordRest } from '../../discord/rest.ts';

export type ActionResult =
  | { ok: true; before: AdSnapshot; after: AdSnapshot }
  | { ok: false; reason: 'not_found' | 'invalid_status' | 'race' };

async function runStatusTransition(
  client: PgClient,
  actorId: string,
  adId: string,
  expectedStatus: AdSnapshot['status'],
  newStatus: AdSnapshot['status'],
  action: string,
): Promise<ActionResult> {
  const before = await getAdById(client, adId);
  if (!before) return { ok: false, reason: 'not_found' };
  if (before.status !== expectedStatus) return { ok: false, reason: 'invalid_status' };
  const ok = await updateAdStatus(client, adId, expectedStatus, newStatus);
  if (!ok) return { ok: false, reason: 'race' };
  const after: AdSnapshot = { ...before, status: newStatus };
  await writeAdminLog(client, {
    actorId,
    action,
    targetKind: 'ad',
    targetId: adId,
    before: { status: before.status },
    after: { status: after.status },
  });
  return { ok: true, before, after };
}

export async function pauseAd(
  client: PgClient,
  actorId: string,
  adId: string,
): Promise<ActionResult> {
  return runStatusTransition(client, actorId, adId, 'approved', 'paused', 'pause');
}

export async function resumeAd(
  client: PgClient,
  actorId: string,
  adId: string,
): Promise<ActionResult> {
  return runStatusTransition(client, actorId, adId, 'paused', 'approved', 'resume');
}

export type ForceEndDeps = {
  rest?: DiscordRest;
};

export async function forceEndAdAction(
  client: PgClient,
  actorId: string,
  adId: string,
  deps: ForceEndDeps = {},
): Promise<ActionResult> {
  const before = await getAdById(client, adId);
  if (!before) return { ok: false, reason: 'not_found' };
  if (before.status !== 'approved' && before.status !== 'paused') {
    return { ok: false, reason: 'invalid_status' };
  }
  const ok = await forceEndAdRow(client, adId, ['approved', 'paused']);
  if (!ok) return { ok: false, reason: 'race' };
  const after: AdSnapshot = { ...before, status: 'expired', endsAt: new Date() };
  await writeAdminLog(client, {
    actorId,
    action: 'force_end',
    targetKind: 'ad',
    targetId: adId,
    before: { status: before.status, ends_at: before.endsAt },
    after: { status: after.status, ends_at: after.endsAt },
  });

  if (deps.rest && before.kind === 'regular' && before.sponsorId) {
    try {
      const dm = await deps.rest.createDmChannel(before.sponsorId);
      await deps.rest.createMessage(dm.id, {
        embeds: [
          {
            title: '⛔ 広告が強制終了されました',
            description: `タイトル: ${before.title}\n管理者の操作により配信を終了しました。`,
            color: 0xed4245,
          },
        ],
      });
    } catch (err) {
      console.warn('force-end: DM notification failed (non-fatal)', { adId, err });
    }
  }

  return { ok: true, before, after };
}
