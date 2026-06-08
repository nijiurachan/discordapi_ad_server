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

/**
 * Persist effectiveWeights() output: set weight_snapshot per surviving id and
 * move paused ids to status='paused' (one UPDATE per id keeps `?`-placeholder
 * binding simple and avoids a dynamic IN list). Caller runs this inside its
 * transaction.
 */
export async function applyEffectiveWeights(
  client: PgClient,
  weights: Array<{ id: string; weightSnapshot: number }>,
  paused: string[],
): Promise<void> {
  for (const w of weights) {
    await client.query('UPDATE ads SET weight_snapshot = ? WHERE id = ?', [
      w.weightSnapshot,
      w.id,
    ]);
  }
  for (const id of paused) {
    await client.query(
      `UPDATE ads
          SET status = 'paused'
        WHERE id = ?`,
      [id],
    );
  }
}

export type ApproveOutcome = 'approved' | 'budget_exceeded' | 'race';

/**
 * Atomic, single-statement conditional approve. D1/SQLite has no interactive
 * transactions or row locks (the Workers D1 client makes BEGIN/COMMIT no-ops),
 * so a read-then-write budget check does NOT serialize. SQLite runs ONE
 * statement atomically and is single-writer, so this conditional UPDATE is the
 * correct concurrency primitive: it flips pending->approved only when the ad is
 * still pending AND Σ weight_alloc over the sponsor's OTHER pending/approved
 * regular non-admin ads, plus this ad's alloc, is still <= the live tier weight.
 *
 * `meta.changes` (rowCount) == 1  => approved.
 * == 0 => either the budget no longer fits (tier shrank since submit) OR another
 *   reviewer already moved the row. We disambiguate with ONE follow-up read of
 *   the ad's status (the write already failed atomically, so this read cannot
 *   reintroduce a TOCTOU): still 'pending' => 'budget_exceeded', else 'race'.
 *
 * Note: starts_at uses `(unixepoch() * 1000)` (D1 epoch-ms), NOT the Postgres
 * `now()`; reviewed_at/reviewed_by are set here too so the whole approve write is
 * one atomic statement.
 */
export async function approvePendingWithinBudget(
  client: PgClient,
  adId: string,
  sponsorId: string,
  thisAlloc: number,
  reviewerId: string,
): Promise<ApproveOutcome> {
  const res = await client.query(
    `UPDATE ads
        SET status = 'approved',
            reviewed_by = ?,
            reviewed_at = (unixepoch() * 1000),
            starts_at = (unixepoch() * 1000)
      WHERE id = ?
        AND status = 'pending'
        AND (
          (SELECT COALESCE(SUM(weight_alloc), 0)
             FROM ads
            WHERE sponsor_id = ?
              AND kind = 'regular'
              AND created_by_admin IS NULL
              AND status IN ('pending', 'approved')
              AND id != ?) + ?
        ) <= (SELECT t.weight
                FROM sponsors s
                JOIN tiers t ON t.id = s.current_tier_id
               WHERE s.discord_user_id = ?)`,
    [reviewerId, adId, sponsorId, adId, thisAlloc, sponsorId],
  );
  if ((res.rowCount ?? 0) === 1) return 'approved';
  const probe = await client.query<{ status: string }>(
    'SELECT status FROM ads WHERE id = ?',
    [adId],
  );
  return probe.rows[0]?.status === 'pending' ? 'budget_exceeded' : 'race';
}
