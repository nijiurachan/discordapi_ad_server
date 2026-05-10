import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { listAdminAds } from '../../../src/db/queries/admin-ads.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(rows: Array<{ rows: unknown[] }>, captured: CapturedCall[]): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return rows[i++] ?? { rows: [] };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('listAdminAds', () => {
  it('returns empty result when no ads match', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ count: '0' }] }, { rows: [] }], captured);
    const result = await listAdminAds(client, {}, 1, 5);
    expect(result.totalCount).toBe(0);
    expect(result.totalPages).toBe(1);
    expect(result.ads).toHaveLength(0);
    expect(captured[0]?.sql).toContain('COUNT(*)');
  });

  it('builds dynamic WHERE clauses for each filter', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ count: '0' }] }, { rows: [] }], captured);
    await listAdminAds(
      client,
      { status: 'approved', kind: 'regular', slot: 'default', sponsorId: 'user-1' },
      1,
      10,
    );
    const countSql = captured[0]?.sql ?? '';
    expect(countSql).toContain('status = $1');
    expect(countSql).toContain('kind = $2');
    expect(countSql).toContain('slot = $3');
    expect(countSql).toContain('sponsor_id = $4');
    const countParams = captured[0]?.params ?? [];
    expect(countParams).toEqual(['approved', 'regular', 'default', 'user-1']);
  });

  it('clamps requested page within [1, totalPages]', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ count: '7' }] }, { rows: [] }], captured);
    const result = await listAdminAds(client, {}, 999, 5);
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
  });

  it('passes pageSize and offset as last two params', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ count: '15' }] }, { rows: [] }], captured);
    await listAdminAds(client, { kind: 'house' }, 2, 5);
    const listParams = captured[1]?.params ?? [];
    // [kind, pageSize, offset]
    expect(listParams).toEqual(['house', 5, 5]);
  });
});
