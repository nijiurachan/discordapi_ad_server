import { describe, expect, it, vi } from 'vitest';
import { sweepDmFallbackChannels } from '../../src/cron/dm-fallback-sweep.ts';
import type { PgClient } from '../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../src/discord/rest.ts';

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

const restWith = (deleteChannel: ReturnType<typeof vi.fn>): DiscordRest =>
  ({ deleteChannel }) as unknown as DiscordRest;

describe('sweepDmFallbackChannels', () => {
  it('returns zeros when nothing is pending', async () => {
    const captured: Capture[] = [];
    const client = mockClient([{ rows: [] }], captured);
    const rest = restWith(vi.fn());
    const result = await sweepDmFallbackChannels(client, rest);
    expect(result).toEqual({ selected: 0, channelDeleted: 0, channelGone: 0, failed: 0 });
    expect(rest.deleteChannel).not.toHaveBeenCalled();
    // SELECT is bounded by a batch LIMIT so a long backlog drains across ticks.
    expect(captured[0]?.sql).toMatch(/LIMIT \$1/);
    expect(captured[0]?.params).toEqual([100]);
  });

  it('runs writes inside BEGIN/COMMIT on the success path', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [
        { rows: [{ id: 'fb-1', channel_id: 'chan-1', ad_id: 'ad-1' }] }, // SELECT
        { rowCount: 0 }, // BEGIN
        { rowCount: 1 }, // UPDATE dm_fallback_channels
        { rowCount: 1 }, // UPDATE ads
        { rowCount: 1 }, // INSERT admin_logs
        { rowCount: 0 }, // COMMIT
      ],
      captured,
    );
    const deleteChannel = vi.fn(async () => ({ id: 'chan-1', type: 0 }));
    const result = await sweepDmFallbackChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 1, channelGone: 0, failed: 0 });

    const sqls = captured.map((c) => c.sql.trim());
    expect(sqls[0]).toMatch(/^SELECT/);
    expect(sqls[1]).toBe('BEGIN');
    expect(sqls[2]).toMatch(/UPDATE dm_fallback_channels/);
    expect(sqls[3]).toMatch(/UPDATE ads/);
    expect(sqls[3]).toMatch(/dm_delivery_status = 'failed'/);
    expect(sqls[3]).toMatch(/NOT IN \('sent', 'fallback_acknowledged'\)/);
    expect(sqls[4]).toMatch(/INSERT INTO admin_logs/);
    expect(sqls[5]).toBe('COMMIT');

    expect(captured[4]?.params?.[1]).toBe('dm_fallback_sweep');
    expect(captured[4]?.params?.[3]).toBe('fb-1');
  });

  it('treats Discord 404 as already-gone and still commits the DB updates', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [
        { rows: [{ id: 'fb-1', channel_id: 'chan-gone', ad_id: 'ad-1' }] },
        { rowCount: 0 }, // BEGIN
        { rowCount: 1 },
        { rowCount: 1 },
        { rowCount: 1 },
        { rowCount: 0 }, // COMMIT
      ],
      captured,
    );
    const deleteChannel = vi.fn(async () => {
      throw new DiscordRestError(404, 'Unknown Channel');
    });
    const result = await sweepDmFallbackChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 0, channelGone: 1, failed: 0 });
    expect(captured.some((c) => c.sql === 'COMMIT')).toBe(true);
  });

  it('skips DB writes and counts a failure on non-404 Discord errors', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [{ rows: [{ id: 'fb-1', channel_id: 'chan-1', ad_id: 'ad-1' }] }],
      captured,
    );
    const deleteChannel = vi.fn(async () => {
      throw new DiscordRestError(500, 'boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await sweepDmFallbackChannels(client, restWith(deleteChannel));
      expect(result).toEqual({ selected: 1, channelDeleted: 0, channelGone: 0, failed: 1 });
      // No transaction at all when Discord 5xx aborts the row early.
      expect(captured.some((c) => c.sql === 'BEGIN')).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rolls back when a write inside the transaction throws (next sweep retries)', async () => {
    // BEGIN + UPDATE dm_fallback_channels succeed, UPDATE ads throws. We must
    // see ROLLBACK and NOT see COMMIT — otherwise the row would be permanently
    // ack'd with no audit trail (the partial index hides it from the next run).
    const captured: Capture[] = [];
    let i = 0;
    const responses: Array<{ rows?: unknown[]; rowCount?: number } | { throw: Error }> = [
      { rows: [{ id: 'fb-1', channel_id: 'chan-1', ad_id: 'ad-1' }] },
      { rowCount: 0 }, // BEGIN
      { rowCount: 1 }, // UPDATE dm_fallback_channels
      { throw: new Error('ads UPDATE blew up') },
      { rowCount: 0 }, // ROLLBACK
    ];
    const client: PgClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        const r = responses[i++] ?? {};
        if ('throw' in r) throw r.throw;
        return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
    const deleteChannel = vi.fn(async () => ({ id: 'chan-1', type: 0 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await sweepDmFallbackChannels(client, restWith(deleteChannel));
      expect(result.failed).toBe(1);
      expect(result.channelDeleted).toBe(1); // Discord delete still counted
      const sqls = captured.map((c) => c.sql.trim());
      expect(sqls).toContain('BEGIN');
      expect(sqls).toContain('ROLLBACK');
      expect(sqls).not.toContain('COMMIT');
      // No admin_logs insert landed.
      expect(sqls.some((s) => /INSERT INTO admin_logs/.test(s))).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
