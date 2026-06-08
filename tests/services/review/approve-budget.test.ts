import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import {
  applyEffectiveWeights,
  getSponsorActiveRegularAllocs,
} from '../../../src/db/queries/review.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };
function mockClient(
  responses: Array<{ rows: unknown[]; rowCount?: number }>,
  captured: CapturedCall[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++];
      if (!r) return { rows: [], rowCount: 0 };
      return { rowCount: r.rowCount ?? r.rows.length, ...r };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('getSponsorActiveRegularAllocs', () => {
  it('returns {id, weightAlloc} for pending+approved regular non-admin ads', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ id: 'a', weight_alloc: 50 }, { id: 'b', weight_alloc: 20 }] }],
      captured,
    );
    const rows = await getSponsorActiveRegularAllocs(client, 'sp-1');
    expect(rows).toEqual([
      { id: 'a', weightAlloc: 50 },
      { id: 'b', weightAlloc: 20 },
    ]);
    expect(captured[0]?.params).toEqual(['sp-1']);
    expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
    expect(captured[0]?.sql).toMatch(/status IN \('pending', 'approved'\)/);
    expect(captured[0]?.sql).toMatch(/created_by_admin IS NULL/);
  });

  it('coerces NULL weight_alloc to 1 (legacy rows / default intent)', async () => {
    const client = mockClient([{ rows: [{ id: 'a', weight_alloc: null }] }]);
    const rows = await getSponsorActiveRegularAllocs(client, 'sp-1');
    expect(rows).toEqual([{ id: 'a', weightAlloc: 1 }]);
  });
});
