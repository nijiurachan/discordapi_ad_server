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
    const client = mockClient([{ rows: [] }]);
    const rest = restWith(vi.fn());
    const result = await sweepDmFallbackChannels(client, rest);
    expect(result).toEqual({ selected: 0, channelDeleted: 0, channelGone: 0, failed: 0 });
    expect(rest.deleteChannel).not.toHaveBeenCalled();
  });

  it('deletes channel, marks ack, sets ad failed, writes admin log on success', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [
        { rows: [{ id: 'fb-1', channel_id: 'chan-1', ad_id: 'ad-1' }] },
        { rowCount: 1 }, // UPDATE dm_fallback_channels
        { rowCount: 1 }, // UPDATE ads
        { rowCount: 1 }, // INSERT admin_logs
      ],
      captured,
    );
    const deleteChannel = vi.fn(async () => ({ id: 'chan-1', type: 0 }));
    const result = await sweepDmFallbackChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 1, channelGone: 0, failed: 0 });

    const sqls = captured.map((c) => c.sql);
    expect(sqls[1]).toMatch(/UPDATE dm_fallback_channels/);
    expect(sqls[2]).toMatch(/UPDATE ads/);
    expect(sqls[2]).toMatch(/dm_delivery_status = 'failed'/);
    expect(sqls[2]).toMatch(/NOT IN \('sent', 'fallback_acknowledged'\)/);
    expect(sqls[3]).toMatch(/INSERT INTO admin_logs/);

    expect(captured[3]?.params?.[1]).toBe('dm_fallback_sweep');
    expect(captured[3]?.params?.[3]).toBe('fb-1');
  });

  it('treats Discord 404 as already-gone and still completes the DB updates', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [
        { rows: [{ id: 'fb-1', channel_id: 'chan-gone', ad_id: 'ad-1' }] },
        { rowCount: 1 },
        { rowCount: 1 },
        { rowCount: 1 },
      ],
      captured,
    );
    const deleteChannel = vi.fn(async () => {
      throw new DiscordRestError(404, 'Unknown Channel');
    });
    const result = await sweepDmFallbackChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 0, channelGone: 1, failed: 0 });
    expect(captured.filter((c) => /UPDATE dm_fallback_channels/.test(c.sql))).toHaveLength(1);
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
      expect(captured).toHaveLength(1); // only the SELECT
    } finally {
      errSpy.mockRestore();
    }
  });
});
