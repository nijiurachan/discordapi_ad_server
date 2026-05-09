import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../src/discord/rest.ts';
import { blockIfUnackedFallback } from '../../src/sponsors/fallback-gate.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(selectRows: unknown[], captured: CapturedCall[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT ID, CHANNEL_ID, CREATED_AT')) {
        return { rows: selectRows };
      }
      // BEGIN, COMMIT, ROLLBACK, UPDATEs
      return { rows: [] };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

type GetChannelImpl = (id: string) => Promise<unknown>;

function mockRest(getChannelImpl: GetChannelImpl): DiscordRest {
  return {
    getChannel: vi.fn(getChannelImpl),
  } as unknown as DiscordRest;
}

describe('blockIfUnackedFallback', () => {
  it('returns ok when there are no unacked fallback channels', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const rest = mockRest(async () => ({ id: 'chan-x', type: 0 }));

    const result = await blockIfUnackedFallback({ client, rest, sponsorId: 'sponsor-1' });

    expect(result.ok).toBe(true);
    expect(rest.getChannel).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
  });

  it('returns block with channel mention when channel still exists', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ id: 'fb-1', channel_id: 'chan-1', created_at: new Date('2026-01-01T00:00:00Z') }],
      captured,
    );
    const rest = mockRest(async () => ({ id: 'chan-1', type: 0 }));

    const result = await blockIfUnackedFallback({ client, rest, sponsorId: 'sponsor-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.channels).toHaveLength(1);
      expect(result.channels[0]?.channelId).toBe('chan-1');
      expect(result.message).toContain('<#chan-1>');
    }
    expect(rest.getChannel).toHaveBeenCalledWith('chan-1');
    // Only the SELECT was issued — no auto-close transaction.
    expect(captured.filter((c) => c.sql.trim().toUpperCase() === 'BEGIN')).toHaveLength(0);
  });

  it('lists multiple existing channels in order with all mentions in the message', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { id: 'fb-1', channel_id: 'chan-A', created_at: new Date('2026-01-01T00:00:00Z') },
        { id: 'fb-2', channel_id: 'chan-B', created_at: new Date('2026-01-02T00:00:00Z') },
        { id: 'fb-3', channel_id: 'chan-C', created_at: new Date('2026-01-03T00:00:00Z') },
      ],
      captured,
    );
    const rest = mockRest(async (id: string) => ({ id, type: 0 }));

    const result = await blockIfUnackedFallback({ client, rest, sponsorId: 'sponsor-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.channels.map((c) => c.channelId)).toEqual(['chan-A', 'chan-B', 'chan-C']);
      const aIdx = result.message.indexOf('<#chan-A>');
      const bIdx = result.message.indexOf('<#chan-B>');
      const cIdx = result.message.indexOf('<#chan-C>');
      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
    }
  });

  it('auto-closes a single 404 row and returns ok', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ id: 'fb-1', channel_id: 'chan-gone', created_at: new Date('2026-01-01T00:00:00Z') }],
      captured,
    );
    const rest = mockRest(async () => {
      throw new DiscordRestError(404, '{"message":"Unknown Channel"}');
    });

    const result = await blockIfUnackedFallback({ client, rest, sponsorId: 'sponsor-1' });

    expect(result.ok).toBe(true);

    // Verify auto-close transactional sequence: BEGIN, UPDATE dm_fallback_channels,
    // UPDATE ads, COMMIT.
    const sqls = captured.map((c) => c.sql.trim().toUpperCase());
    const beginIdx = sqls.findIndex((s) => s === 'BEGIN');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(sqls[beginIdx + 1]).toContain('UPDATE DM_FALLBACK_CHANNELS');
    expect(sqls[beginIdx + 2]).toMatch(/^UPDATE ADS/);
    expect(sqls[beginIdx + 3]).toBe('COMMIT');

    // Update params reference the fallback row id.
    expect(captured[beginIdx + 1]?.params).toEqual(['fb-1']);
    expect(captured[beginIdx + 2]?.params).toEqual(['fb-1']);

    // The ads UPDATE should set fallback_acknowledged.
    expect(captured[beginIdx + 2]?.sql).toContain("dm_delivery_status = 'fallback_acknowledged'");
  });

  it('auto-closes only the 404 row and keeps the surviving block', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { id: 'fb-1', channel_id: 'chan-alive', created_at: new Date('2026-01-01T00:00:00Z') },
        { id: 'fb-2', channel_id: 'chan-gone', created_at: new Date('2026-01-02T00:00:00Z') },
      ],
      captured,
    );
    const rest = mockRest(async (id: string) => {
      if (id === 'chan-gone') {
        throw new DiscordRestError(404, '{"message":"Unknown Channel"}');
      }
      return { id, type: 0 };
    });

    const result = await blockIfUnackedFallback({ client, rest, sponsorId: 'sponsor-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.channels.map((c) => c.channelId)).toEqual(['chan-alive']);
      expect(result.message).toContain('<#chan-alive>');
      expect(result.message).not.toContain('<#chan-gone>');
    }

    // Auto-close ran for fb-2 (the orphan) only.
    const updateRows = captured.filter((c) => c.sql.trim().toUpperCase().startsWith('UPDATE'));
    expect(updateRows).toHaveLength(2);
    expect(updateRows.every((u) => u.params?.[0] === 'fb-2')).toBe(true);
  });

  it('does NOT auto-close when REST returns a non-404 error and keeps the row blocked', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ id: 'fb-1', channel_id: 'chan-flaky', created_at: new Date('2026-01-01T00:00:00Z') }],
      captured,
    );
    const rest = mockRest(async () => {
      throw new DiscordRestError(500, '{"message":"Internal Server Error"}');
    });

    const result = await blockIfUnackedFallback({ client, rest, sponsorId: 'sponsor-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.channels.map((c) => c.channelId)).toEqual(['chan-flaky']);
    }

    // No transaction was started.
    const sqls = captured.map((c) => c.sql.trim().toUpperCase());
    expect(sqls).not.toContain('BEGIN');
    expect(sqls).not.toContain('COMMIT');
  });

  it('does NOT auto-close on non-DiscordRestError exceptions and keeps the row blocked', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ id: 'fb-1', channel_id: 'chan-network', created_at: new Date('2026-01-01T00:00:00Z') }],
      captured,
    );
    const rest = mockRest(async () => {
      throw new Error('network down');
    });

    const result = await blockIfUnackedFallback({ client, rest, sponsorId: 'sponsor-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.channels.map((c) => c.channelId)).toEqual(['chan-network']);
    }

    const sqls = captured.map((c) => c.sql.trim().toUpperCase());
    expect(sqls).not.toContain('BEGIN');
  });
});
