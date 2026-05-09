import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import {
  createFallbackRow,
  findActiveFallback,
  findFallbackById,
  markFallbackAcknowledged,
} from '../../../src/db/queries/fallback.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(rows: unknown[], captured: CapturedCall[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

const dbRow = {
  id: 'fb-1',
  ad_id: 'ad-1',
  sponsor_id: 'sponsor-1',
  channel_id: 'chan-1',
  created_at: new Date('2026-05-01T00:00:00Z'),
  expires_at: new Date('2026-05-08T00:00:00Z'),
  acknowledged_at: null,
};

describe('findActiveFallback', () => {
  it('returns mapped FallbackRow when DB returns a row', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([dbRow], captured);
    const r = await findActiveFallback(client, 'ad-1');
    expect(r).toEqual({
      id: 'fb-1',
      adId: 'ad-1',
      sponsorId: 'sponsor-1',
      channelId: 'chan-1',
      createdAt: dbRow.created_at,
      expiresAt: dbRow.expires_at,
      acknowledgedAt: null,
    });
    expect(captured[0]?.sql).toMatch(/FROM dm_fallback_channels/);
    expect(captured[0]?.sql).toMatch(/acknowledged_at IS NULL/);
    expect(captured[0]?.sql).toMatch(/expires_at > now\(\)/);
    expect(captured[0]?.params).toEqual(['ad-1']);
  });

  it('returns null when no row found', async () => {
    const client = mockClient([]);
    const r = await findActiveFallback(client, 'ad-x');
    expect(r).toBeNull();
  });
});

describe('createFallbackRow', () => {
  it('issues INSERT with all 5 columns', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const expiresAt = new Date('2026-05-15T00:00:00Z');
    await createFallbackRow(client, {
      id: 'fb-1',
      adId: 'ad-1',
      sponsorId: 'sponsor-1',
      channelId: 'chan-1',
      expiresAt,
    });
    expect(captured[0]?.sql).toMatch(/INSERT INTO dm_fallback_channels/);
    expect(captured[0]?.params).toEqual(['fb-1', 'ad-1', 'sponsor-1', 'chan-1', expiresAt]);
  });
});

describe('findFallbackById', () => {
  it('returns mapped row when found', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([dbRow], captured);
    const r = await findFallbackById(client, 'fb-1');
    expect(r?.id).toBe('fb-1');
    expect(r?.adId).toBe('ad-1');
    expect(r?.acknowledgedAt).toBeNull();
    expect(captured[0]?.sql).toMatch(/WHERE id = \$1/);
    expect(captured[0]?.params).toEqual(['fb-1']);
  });

  it('returns null when not found', async () => {
    const client = mockClient([]);
    expect(await findFallbackById(client, 'no-such')).toBeNull();
  });
});

describe('markFallbackAcknowledged', () => {
  it('issues UPDATE with acknowledged_at = now() and id guard', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    await markFallbackAcknowledged(client, 'fb-1');
    expect(captured[0]?.sql).toMatch(/UPDATE dm_fallback_channels SET acknowledged_at = now\(\)/);
    expect(captured[0]?.sql).toMatch(/WHERE id = \$1 AND acknowledged_at IS NULL/);
    expect(captured[0]?.params).toEqual(['fb-1']);
  });
});
