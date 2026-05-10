import type { S3Client } from '@aws-sdk/client-s3';
import type { PgClient } from '../db/client.ts';
import { deleteObject } from '../storage/s3.ts';

export type SweepDraftsResult = {
  deleted: number;
  s3Failed: number;
};

/**
 * Hourly sweep of expired ad_drafts.
 *
 * Single source of truth: one `DELETE … RETURNING id, image_key` returns
 * exactly the rows we removed, and we then call S3 deleteObject for each
 * returned key. This avoids the race that a SELECT-then-DELETE pair would
 * have, where rows expiring during the S3 loop would slip into the DELETE
 * but be missed by S3 cleanup, leaving orphaned `staging/` objects.
 *
 * S3 failures still don't roll back the DB delete (issue #33 design choice 2):
 * orphaned objects can be reaped offline; the wider invariant is "expired
 * drafts disappear hourly".
 */
export async function sweepExpiredDrafts(
  client: PgClient,
  s3: S3Client,
  bucket: string,
): Promise<SweepDraftsResult> {
  const del = await client.query<{ id: string; image_key: string }>(
    'DELETE FROM ad_drafts WHERE expires_at < now() RETURNING id, image_key',
  );
  let s3Failed = 0;
  for (const row of del.rows) {
    try {
      await deleteObject(s3, bucket, row.image_key);
    } catch (err) {
      s3Failed++;
      console.error('sweep-drafts: s3 delete failed', { id: row.id, key: row.image_key, err });
    }
  }
  return { deleted: del.rows.length, s3Failed };
}
