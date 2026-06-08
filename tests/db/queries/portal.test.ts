import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import {
  closePortalRow,
  createPortalRow,
  findOpenPortalByChannel,
  findOpenPortalBySponsor,
  findPortalById,
  getSponsorActiveBanners,
  setPortalDashboardMessageId,
  touchPortalActivity,
} from '../../../src/db/queries/portal.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(rows: unknown[], captured: Capture[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

const dbRow = {
  id: 'p-1',
  sponsor_id: 's-1',
  channel_id: 'c-1',
  dashboard_message_id: 'm-1',
  created_at: new Date('2026-06-01T00:00:00Z'),
  last_active_at: new Date('2026-06-02T00:00:00Z'),
  archived_at: null,
};

describe('findOpenPortalBySponsor', () => {
  it('selects active row (archived_at IS NULL) and maps fields', async () => {
    const captured: Capture[] = [];
    const r = await findOpenPortalBySponsor(mockClient([dbRow], captured), 's-1');
    expect(r).toEqual({
      id: 'p-1',
      sponsorId: 's-1',
      channelId: 'c-1',
      dashboardMessageId: 'm-1',
      createdAt: dbRow.created_at,
      lastActiveAt: dbRow.last_active_at,
      archivedAt: null,
    });
    expect(captured[0]?.sql).toMatch(/WHERE sponsor_id = \?[\s\S]*archived_at IS NULL/);
    expect(captured[0]?.params).toEqual(['s-1']);
  });
  it('returns null on empty', async () => {
    expect(await findOpenPortalBySponsor(mockClient([]), 's-1')).toBeNull();
  });
});

describe('createPortalRow', () => {
  it('INSERTs id, sponsor_id, channel_id', async () => {
    const captured: Capture[] = [];
    await createPortalRow(mockClient([], captured), {
      id: 'p-1',
      sponsorId: 's-1',
      channelId: 'c-1',
    });
    expect(captured[0]?.sql).toMatch(/INSERT INTO portal_channels/);
    expect(captured[0]?.params).toEqual(['p-1', 's-1', 'c-1']);
  });
});

describe('setPortalDashboardMessageId', () => {
  it('UPDATEs dashboard_message_id by id', async () => {
    const captured: Capture[] = [];
    await setPortalDashboardMessageId(mockClient([], captured), 'p-1', 'm-9');
    expect(captured[0]?.sql).toMatch(/UPDATE portal_channels SET dashboard_message_id = \?/);
    expect(captured[0]?.params).toEqual(['m-9', 'p-1']);
  });
});

describe('touchPortalActivity', () => {
  it('bumps last_active_at by id', async () => {
    const captured: Capture[] = [];
    await touchPortalActivity(mockClient([], captured), 'p-1');
    expect(captured[0]?.sql).toMatch(
      /UPDATE portal_channels SET last_active_at = \(unixepoch\(\) \* 1000\)/,
    );
    expect(captured[0]?.params).toEqual(['p-1']);
  });
});

describe('closePortalRow', () => {
  it('archives only while still active', async () => {
    const captured: Capture[] = [];
    await closePortalRow(mockClient([], captured), 'p-1');
    expect(captured[0]?.sql).toMatch(
      /UPDATE portal_channels SET archived_at = \(unixepoch\(\) \* 1000\) WHERE id = \? AND archived_at IS NULL/,
    );
    expect(captured[0]?.params).toEqual(['p-1']);
  });
});

describe('findPortalById', () => {
  it('selects by id', async () => {
    const captured: Capture[] = [];
    await findPortalById(mockClient([dbRow], captured), 'p-1');
    expect(captured[0]?.sql).toMatch(/WHERE id = \?/);
    expect(captured[0]?.params).toEqual(['p-1']);
  });
});

describe('findOpenPortalByChannel', () => {
  it('selects the active row by channel_id', async () => {
    const captured: Capture[] = [];
    const r = await findOpenPortalByChannel(mockClient([dbRow], captured), 'c-1');
    expect(r?.sponsorId).toBe('s-1');
    expect(captured[0]?.sql).toMatch(/WHERE channel_id = \?[\s\S]*archived_at IS NULL/);
    expect(captured[0]?.params).toEqual(['c-1']);
  });
  it('returns null on empty', async () => {
    expect(await findOpenPortalByChannel(mockClient([]), 'c-1')).toBeNull();
  });
});

describe('getSponsorActiveBanners', () => {
  it('selects approved+pending regular ads with weight_alloc, maps to camelCase', async () => {
    const captured: Capture[] = [];
    const banners = await getSponsorActiveBanners(
      mockClient(
        [{ id: 'a-1', slot: 'default', title: 'T', status: 'approved', weight_alloc: 5 }],
        captured,
      ),
      's-1',
    );
    expect(banners).toEqual([
      { id: 'a-1', slot: 'default', title: 'T', status: 'approved', weightAlloc: 5 },
    ]);
    expect(captured[0]?.sql).toMatch(/FROM ads/);
    expect(captured[0]?.sql).toMatch(/status IN \('approved', 'pending'\)/);
    expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
    expect(captured[0]?.params).toEqual(['s-1']);
  });
});
