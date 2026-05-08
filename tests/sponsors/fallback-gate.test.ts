import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { blockIfUnackedFallback } from '../../src/sponsors/fallback-gate.ts';

function mockClient(rows: unknown[]): PgClient {
  return {
    query: vi.fn(async () => ({ rows })) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('blockIfUnackedFallback', () => {
  it('returns ok when there are no unacked fallback channels', async () => {
    const client = mockClient([]);
    const result = await blockIfUnackedFallback(client, 'sponsor-1');
    expect(result.ok).toBe(true);
  });

  it('returns block with channel mention for a single row', async () => {
    const client = mockClient([
      { id: 'fb-1', channel_id: 'chan-1', created_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    const result = await blockIfUnackedFallback(client, 'sponsor-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.channels).toHaveLength(1);
      expect(result.channels[0]?.channelId).toBe('chan-1');
      expect(result.message).toContain('<#chan-1>');
    }
  });

  it('lists multiple channels in order with all mentions in the message', async () => {
    const client = mockClient([
      { id: 'fb-1', channel_id: 'chan-A', created_at: new Date('2026-01-01T00:00:00Z') },
      { id: 'fb-2', channel_id: 'chan-B', created_at: new Date('2026-01-02T00:00:00Z') },
      { id: 'fb-3', channel_id: 'chan-C', created_at: new Date('2026-01-03T00:00:00Z') },
    ]);
    const result = await blockIfUnackedFallback(client, 'sponsor-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.channels.map((c) => c.channelId)).toEqual(['chan-A', 'chan-B', 'chan-C']);
      expect(result.message).toContain('<#chan-A>');
      expect(result.message).toContain('<#chan-B>');
      expect(result.message).toContain('<#chan-C>');
      // Order preserved in the mentions block
      const aIdx = result.message.indexOf('<#chan-A>');
      const bIdx = result.message.indexOf('<#chan-B>');
      const cIdx = result.message.indexOf('<#chan-C>');
      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
    }
  });
});
