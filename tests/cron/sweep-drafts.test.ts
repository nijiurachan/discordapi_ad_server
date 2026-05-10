import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { sweepExpiredDrafts } from '../../src/cron/sweep-drafts.ts';
import type { PgClient } from '../../src/db/client.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(
  responses: Array<{ rows?: unknown[]; rowCount?: number }>,
  captured: Capture[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++] ?? {};
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('sweepExpiredDrafts', () => {
  it('returns zeros and does not call S3 when nothing is expired', async () => {
    const client = mockClient([{ rows: [] }]);
    const send = vi.fn();
    const s3 = { send } as unknown as S3Client;
    const result = await sweepExpiredDrafts(client, s3, 'bucket');
    expect(result).toEqual({ deleted: 0, s3Failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses DELETE ... RETURNING as the single source of truth, then cleans S3', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [
        {
          rows: [
            { id: 'd-1', image_key: 'staging/a.png' },
            { id: 'd-2', image_key: 'staging/b.png' },
          ],
        },
      ],
      captured,
    );
    const send = vi.fn(async () => ({}));
    const s3 = { send } as unknown as S3Client;
    const result = await sweepExpiredDrafts(client, s3, 'bucket');
    expect(result).toEqual({ deleted: 2, s3Failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    // One round-trip only: the DELETE itself returns the keys to clean.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(
      /DELETE FROM ad_drafts WHERE expires_at < now\(\) RETURNING id, image_key/,
    );
  });

  it('continues past S3 failures (orphans accepted, DB delete already committed)', async () => {
    const client = mockClient([
      {
        rows: [
          { id: 'd-1', image_key: 'staging/a.png' },
          { id: 'd-2', image_key: 'staging/b.png' },
        ],
      },
    ]);
    const send = vi.fn().mockRejectedValueOnce(new Error('s3 down')).mockResolvedValueOnce({});
    const s3 = { send } as unknown as S3Client;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await sweepExpiredDrafts(client, s3, 'bucket');
      expect(result).toEqual({ deleted: 2, s3Failed: 1 });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
