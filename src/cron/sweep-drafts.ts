import type { S3Client } from '@aws-sdk/client-s3';
import type { PgClient } from '../db/client.ts';
import { deleteObject } from '../storage/s3.ts';

export type SweepDraftsResult = {
  selected: number;
  s3Failed: number;
  deleted: number;
};

/**
 * Hourly sweep of expired ad_drafts.
 *
 * Flow: SELECT expired -> per-row S3 deleteObject (best-effort, errors logged)
 * -> single DELETE for all expired rows. We intentionally DELETE every expired
 * row regardless of S3 outcome (issue #33 design choice 2): the spec mandates
 * "log but don't abort", and orphaned `staging/` objects can be reaped offline
 * later. A literal BEGIN/COMMIT around the SELECT/DELETE buys nothing here
 * because the per-row S3 calls happen between them — the wider invariant is
 * "expired drafts disappear hourly", not "S3 and DB always agree exactly".
 */
export async function sweepExpiredDrafts(
  client: PgClient,
  s3: S3Client,
  bucket: string,
): Promise<SweepDraftsResult> {
  const sel = await client.query<{ id: string; image_key: string }>(
    'SELECT id, image_key FROM ad_drafts WHERE expires_at < now()',
  );
  let s3Failed = 0;
  for (const row of sel.rows) {
    try {
      await deleteObject(s3, bucket, row.image_key);
    } catch (err) {
      s3Failed++;
      console.error('sweep-drafts: s3 delete failed', { id: row.id, key: row.image_key, err });
    }
  }
  const del = await client.query('DELETE FROM ad_drafts WHERE expires_at < now()');
  return { selected: sel.rows.length, s3Failed, deleted: del.rowCount ?? 0 };
}
