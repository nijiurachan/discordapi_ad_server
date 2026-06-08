import { describe, expect, it, vi } from 'vitest';
import { sweepPortalChannels } from '../../src/cron/portal-sweep.ts';
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

describe('sweepPortalChannels', () => {
  it('returns zeros when nothing is idle, bounded by a batch LIMIT', async () => {
    const captured: Capture[] = [];
    const result = await sweepPortalChannels(
      mockClient([{ rows: [] }], captured),
      restWith(vi.fn()),
    );
    expect(result).toEqual({ selected: 0, channelDeleted: 0, channelGone: 0, failed: 0 });
    expect(captured[0]?.sql).toMatch(/LIMIT \?/);
    // SELECT filters archived_at IS NULL and last_active_at older than the TTL cutoff.
    expect(captured[0]?.sql).toMatch(/archived_at IS NULL/);
    expect(captured[0]?.sql).toMatch(/last_active_at < \(unixepoch\(\) \* 1000\)/);
  });

  it('deletes the channel then archives the row', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [
        { rows: [{ id: 'p-1', channel_id: 'c-1' }] }, // SELECT
        { rowCount: 1 }, // UPDATE archived_at
      ],
      captured,
    );
    const deleteChannel = vi.fn(async () => ({ id: 'c-1', type: 0 }));
    const result = await sweepPortalChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 1, channelGone: 0, failed: 0 });
    expect(deleteChannel).toHaveBeenCalledWith('c-1');
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(true);
  });

  it('treats 404 as already-gone and still archives', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [{ rows: [{ id: 'p-1', channel_id: 'gone' }] }, { rowCount: 1 }],
      captured,
    );
    const deleteChannel = vi.fn(async () => {
      throw new DiscordRestError(404, 'Unknown Channel');
    });
    const result = await sweepPortalChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 0, channelGone: 1, failed: 0 });
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(true);
  });

  it('counts a failure and skips the row on non-404 Discord errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: Capture[] = [];
    const client = mockClient([{ rows: [{ id: 'p-1', channel_id: 'c-1' }] }], captured);
    const deleteChannel = vi.fn(async () => {
      throw new DiscordRestError(500, 'boom');
    });
    const result = await sweepPortalChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 0, channelGone: 0, failed: 1 });
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(false);
  });
});
