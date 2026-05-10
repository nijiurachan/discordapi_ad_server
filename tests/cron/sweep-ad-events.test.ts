import { describe, expect, it, vi } from 'vitest';
import { sweepAdEvents } from '../../src/cron/sweep-ad-events.ts';
import type { PgClient } from '../../src/db/client.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(rowCounts: number[], captured: Capture[] = []): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const rowCount = rowCounts[i++] ?? 0;
      return { rows: [], rowCount };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('sweepAdEvents', () => {
  it('issues batched DELETEs and stops at the first empty batch', async () => {
    const captured: Capture[] = [];
    const client = mockClient([1000, 1000, 350, 0], captured);
    const result = await sweepAdEvents(client);
    expect(result).toEqual({ batches: 3, deleted: 2350, hitMaxBatches: false });
    expect(captured).toHaveLength(4);
    for (const c of captured) {
      expect(c.sql).toMatch(/DELETE FROM ad_events/);
      expect(c.sql).toMatch(/180 days/);
      expect(c.sql).toMatch(/LIMIT \$1/);
      expect(c.params).toEqual([1000]);
    }
  });

  it('respects custom batchSize', async () => {
    const captured: Capture[] = [];
    const client = mockClient([10, 0], captured);
    const result = await sweepAdEvents(client, { batchSize: 10 });
    expect(result.deleted).toBe(10);
    expect(captured[0]?.params).toEqual([10]);
  });

  it('stops at maxBatches and reports hitMaxBatches=true', async () => {
    // Always returns 5 rows (never empty) — the cap should kick in.
    const captured: Capture[] = [];
    const fixedRows = 5;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [], rowCount: fixedRows };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
    const result = await sweepAdEvents(client, { batchSize: 1, maxBatches: 3 });
    expect(result).toEqual({ batches: 3, deleted: 15, hitMaxBatches: true });
    expect(captured).toHaveLength(3);
  });

  it('returns zeros when nothing to delete', async () => {
    const result = await sweepAdEvents(mockClient([0]));
    expect(result).toEqual({ batches: 0, deleted: 0, hitMaxBatches: false });
  });
});
