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
  // D1/SQLite only supports `?` placeholders. Build SET clause and its params
  // first (in order), then append the WHERE params at the end. `startsAt`
  // accepts a literal 'now' to map to `(unixepoch() * 1000)` without a bind.
  const sets: string[] = ['status = ?'];
  const setParams: unknown[] = [patch.status];
  if (Object.hasOwn(patch, 'rejectReason')) {
    sets.push('reject_reason = ?');
    setParams.push(patch.rejectReason);
  }
  if (Object.hasOwn(patch, 'reviewedBy')) {
    sets.push('reviewed_by = ?', 'reviewed_at = (unixepoch() * 1000)');
    setParams.push(patch.reviewedBy);
  }
  if (Object.hasOwn(patch, 'startsAt')) {
    if (patch.startsAt === 'now') {
      sets.push('starts_at = (unixepoch() * 1000)');
    } else {
      sets.push('starts_at = ?');
      // Date → epoch ms for SQLite integer column. null passes through.
      setParams.push(patch.startsAt instanceof Date ? patch.startsAt.getTime() : patch.startsAt);
    }
  }
  if (Object.hasOwn(patch, 'weightSnapshot')) {
    sets.push('weight_snapshot = ?');
    setParams.push(patch.weightSnapshot);
  }
  const sql = `UPDATE ads SET ${sets.join(', ')} WHERE id = ? AND status = ?`;
  const res = await client.query(sql, [...setParams, adId, fromStatus]);
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

export type ActiveAlloc = { id: string; weightAlloc: number };

/**
 * The sponsor's regular, non-admin ads currently holding budget (pending or
 * approved), with their intended weight_alloc. NULL alloc (legacy rows or the
 * implicit default) is coerced to 1. Ordered by id for deterministic
 * effectiveWeights output. Read inside the caller's transaction.
 */
export async function getSponsorActiveRegularAllocs(
  client: PgClient,
  sponsorId: string,
): Promise<ActiveAlloc[]> {
  const res = await client.query<{ id: string; weight_alloc: number | null }>(
    `SELECT id, weight_alloc
       FROM ads
      WHERE sponsor_id = ?
        AND kind = 'regular'
        AND created_by_admin IS NULL
        AND status IN ('pending', 'approved')
      ORDER BY id`,
    [sponsorId],
  );
  return res.rows.map((r) => ({ id: r.id, weightAlloc: r.weight_alloc ?? 1 }));
}
