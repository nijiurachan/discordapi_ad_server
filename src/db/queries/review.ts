import type { PgClient } from '../client.ts';

export type AdStatus = 'pending' | 'approved' | 'paused' | 'rejected' | 'expired' | 'withdrawn';

export type ReviewAction = 'approved' | 'rejected' | 'withdrawn';

export type StatusUpdatePatch = {
  status: AdStatus;
  rejectReason?: string | null;
  reviewedBy?: string | null;
  startsAt?: Date | 'now' | null;
  weightSnapshot?: number | null;
};

export type StatusUpdateResult = { ok: true; rowsAffected: 1 } | { ok: false; reason: 'race' };

/**
 * Update ads row only if current status matches `fromStatus`. Returns 'race' when
 * the row was already moved by another reviewer (concurrent click).
 */
export async function updateAdStatusOptimistic(
  client: PgClient,
  adId: string,
  fromStatus: AdStatus,
  patch: StatusUpdatePatch,
): Promise<StatusUpdateResult> {
  const sets: string[] = ['status = ?'];
  const params: unknown[] = [adId, fromStatus, patch.status];
  let i = 4;
  if (Object.hasOwn(patch, 'rejectReason')) {
    sets.push(`reject_reason = $${i++}`);
    params.push(patch.rejectReason);
  }
  if (Object.hasOwn(patch, 'reviewedBy')) {
    sets.push(`reviewed_by = $${i++}`, 'reviewed_at = (unixepoch() * 1000)');
    params.push(patch.reviewedBy);
  }
  if (Object.hasOwn(patch, 'startsAt')) {
    if (patch.startsAt === 'now') {
      sets.push('starts_at = (unixepoch() * 1000)');
    } else {
      sets.push(`starts_at = $${i++}`);
      params.push(patch.startsAt);
    }
  }
  if (Object.hasOwn(patch, 'weightSnapshot')) {
    sets.push(`weight_snapshot = $${i++}`);
    params.push(patch.weightSnapshot);
  }
  const sql = `UPDATE ads SET ${sets.join(', ')} WHERE id = ? AND status = ?`;
  const res = await client.query(sql, params);
  const rowsAffected = res.rowCount ?? 0;
  if (rowsAffected === 0) return { ok: false, reason: 'race' };
  return { ok: true, rowsAffected: 1 };
}

export async function insertReviewLog(
  client: PgClient,
  adId: string,
  reviewerId: string,
  action: ReviewAction,
  reason?: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO review_logs (ad_id, reviewer_id, action, reason)
     VALUES (?, ?, ?, ?)`,
    [adId, reviewerId, action, reason ?? null],
  );
}

export async function setAdReviewMessageId(
  client: PgClient,
  adId: string,
  messageId: string,
): Promise<void> {
  await client.query('UPDATE ads SET review_message_id = ? WHERE id = ?', [messageId, adId]);
}
