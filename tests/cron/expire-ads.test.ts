import { describe, expect, it, vi } from 'vitest';
import { expireAds } from '../../src/cron/expire-ads.ts';
import type { PgClient } from '../../src/db/client.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(rowCount: number, captured: Capture[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('expireAds', () => {
  it('issues an UPDATE that targets only approved ads with past ends_at', async () => {
    const captured: Capture[] = [];
    const client = mockClient(3, captured);
    const result = await expireAds(client);
    expect(result).toEqual({ expired: 3 });
    const sql = captured[0]?.sql ?? '';
    expect(sql).toMatch(/UPDATE ads/);
    expect(sql).toMatch(/SET status = 'expired'/);
    expect(sql).toMatch(/status = 'approved'/);
    expect(sql).toMatch(/ends_at IS NOT NULL/);
    expect(sql).toMatch(/ends_at < now\(\)/);
  });

  it('reports zero when nothing matches', async () => {
    const result = await expireAds(mockClient(0));
    expect(result).toEqual({ expired: 0 });
  });
});
