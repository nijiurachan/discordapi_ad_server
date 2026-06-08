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
  updateAdWeightWithinBudget,
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

// A mock that returns an explicit rowCount independent of rows. The atomic
// weight UPDATE returns no rows, so its applied/rejected outcome is conveyed
// purely via rowCount (1 = applied, 0 = guard failed / not owner / gone).
function mockClientRowCount(rowCount: number, captured: Capture[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount };
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
    expect(captured[0]?.sql).toMatch(/created_by_admin IS NULL/);
    expect(captured[0]?.params).toEqual(['s-1']);
  });

  it('maps a null weight_alloc to weightAlloc:null and orders approved before pending', async () => {
    const captured: Capture[] = [];
    const banners = await getSponsorActiveBanners(
      mockClient(
        [
          { id: 'a-1', slot: 'default', title: 'P', status: 'pending', weight_alloc: null },
          { id: 'a-2', slot: 'default', title: 'A', status: 'approved', weight_alloc: 3 },
        ],
        captured,
      ),
      's-1',
    );
    // A null weight_alloc must survive as null (NOT coerced to 0) so the UI can
    // distinguish "not yet allocated" from "zero".
    expect(banners[0]).toEqual({
      id: 'a-1',
      slot: 'default',
      title: 'P',
      status: 'pending',
      weightAlloc: null,
    });
    expect(banners[1]?.weightAlloc).toBe(3);
    expect(captured[0]?.sql).toMatch(
      /ORDER BY[\s\S]*CASE status WHEN 'approved' THEN 1 WHEN 'pending' THEN 2/,
    );
  });
});

describe('updateAdWeightWithinBudget', () => {
  const AD_ID = 'ad-1';
  const CLICKER = 'clicker-1';

  it('an OVER-BUDGET sponsor reducing a banner weight SUCCEEDS (changes=1)', async () => {
    // Even when the sponsor is over budget (OTHER alloc alone exceeds tier),
    // a decrease must still apply: the guard short-circuits because the new
    // weight is <= the row's current weight_alloc.
    const captured: Capture[] = [];
    const ok = await updateAdWeightWithinBudget(mockClientRowCount(1, captured), AD_ID, CLICKER, 2);
    expect(ok).toBe(true);
    const sql = captured[0]?.sql ?? '';
    // The guard must include a "decrease is always safe" clause comparing the
    // new weight to the row's CURRENT weight_alloc.
    expect(sql).toMatch(/<= COALESCE\(weight_alloc, 0\)/);
    // Ownership + kind + admin + status guards are all still present.
    expect(sql).toMatch(/sponsor_id = \?/);
    expect(sql).toMatch(/kind = 'regular'/);
    expect(sql).toMatch(/created_by_admin IS NULL/);
    expect(sql).toMatch(/status IN \('pending', 'approved'\)/);
  });

  it('an increase that exceeds budget is still REJECTED (changes=0)', async () => {
    const captured: Capture[] = [];
    const ok = await updateAdWeightWithinBudget(
      mockClientRowCount(0, captured),
      AD_ID,
      CLICKER,
      99,
    );
    expect(ok).toBe(false);
    const sql = captured[0]?.sql ?? '';
    // The budget sum-check clause is still present for increases.
    expect(sql).toMatch(/SELECT COALESCE\(SUM\(weight_alloc\), 0\)/);
    expect(sql).toMatch(/<= \(SELECT t\.weight/);
  });

  it('a non-owner is still REJECTED (changes=0)', async () => {
    const ok = await updateAdWeightWithinBudget(mockClientRowCount(0), AD_ID, 'someone-else', 1);
    expect(ok).toBe(false);
  });

  it('an in-budget increase still SUCCEEDS (changes=1)', async () => {
    const ok = await updateAdWeightWithinBudget(mockClientRowCount(1), AD_ID, CLICKER, 5);
    expect(ok).toBe(true);
  });

  it('binds params in the correct repeated-? order including the decrease compare', async () => {
    const captured: Capture[] = [];
    await updateAdWeightWithinBudget(mockClientRowCount(1, captured), AD_ID, CLICKER, 4);
    // Placeholder order across the statement:
    //   SET weight_alloc = ?               -> newWeight
    //   WHERE id = ?                        -> adId
    //   AND sponsor_id = ?                  -> clickerId
    //   AND ( ? <= COALESCE(weight_alloc,0) -> newWeight (decrease compare)
    //     OR ( (subquery sponsor_id = ?     -> clickerId
    //            ... id != ?) + ?           -> adId, newWeight
    //        ) <= (SELECT t.weight ... s.discord_user_id = ?) -> clickerId
    //   )
    expect(captured[0]?.params).toEqual([4, AD_ID, CLICKER, 4, CLICKER, AD_ID, 4, CLICKER]);
  });
});
