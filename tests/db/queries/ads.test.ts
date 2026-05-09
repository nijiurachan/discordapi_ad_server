import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { getAggregateStats, getSponsorAds, withdrawAd } from '../../../src/db/queries/ads.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(
  responses: Array<{ rows: unknown[] }>,
  captured: CapturedCall[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return responses[i++] ?? { rows: [] };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('getSponsorAds', () => {
  it('returns mapped rows in expected shape', async () => {
    const captured: CapturedCall[] = [];
    const now = new Date('2026-05-09T12:00:00Z');
    const client = mockClient(
      [
        {
          rows: [
            {
              id: 'ad-1',
              slot: 'default',
              title: 'Title',
              body: 'Body',
              link_url: 'https://example.com',
              image_key: 'staging/abc/orig.png',
              image_mime: 'image/png',
              status: 'pending',
              weight_snapshot: null,
              created_at: now,
              starts_at: null,
              ends_at: null,
            },
          ],
        },
      ],
      captured,
    );
    const ads = await getSponsorAds(client, 'user-1', 5);
    expect(ads).toHaveLength(1);
    expect(ads[0]).toEqual({
      id: 'ad-1',
      slot: 'default',
      title: 'Title',
      body: 'Body',
      linkUrl: 'https://example.com',
      imageKey: 'staging/abc/orig.png',
      imageMime: 'image/png',
      status: 'pending',
      weightSnapshot: null,
      createdAt: now,
      startsAt: null,
      endsAt: null,
    });
    expect(captured[0]?.sql).toMatch(/FROM ads/);
    expect(captured[0]?.sql).toMatch(/WHERE sponsor_id = \$1/);
    expect(captured[0]?.params).toEqual(['user-1', 5]);
  });

  it('returns [] when no ads', async () => {
    const client = mockClient([{ rows: [] }]);
    const ads = await getSponsorAds(client, 'user-x');
    expect(ads).toEqual([]);
  });
});

describe('withdrawAd', () => {
  it('happy path: BEGIN → SELECT FOR UPDATE → UPDATE → INSERT → COMMIT', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // BEGIN
        { rows: [{ sponsor_id: 'user-1', status: 'approved' }] }, // SELECT FOR UPDATE
        { rows: [] }, // UPDATE
        { rows: [] }, // INSERT review_logs
        { rows: [] }, // COMMIT
      ],
      captured,
    );
    const res = await withdrawAd(client, 'user-1', 'ad-1');
    expect(res).toEqual({ ok: true });
    expect(captured[0]?.sql).toBe('BEGIN');
    expect(captured[1]?.sql).toMatch(/SELECT sponsor_id, status FROM ads.*FOR UPDATE/s);
    expect(captured[2]?.sql).toMatch(/UPDATE ads/);
    expect(captured[2]?.sql).toMatch(/status = 'withdrawn'/);
    expect(captured[3]?.sql).toMatch(/INSERT INTO review_logs/);
    expect(captured[3]?.params).toEqual(['ad-1', 'user-1']);
    expect(captured[4]?.sql).toBe('COMMIT');
  });

  it('not_found: row missing → ROLLBACK', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // BEGIN
        { rows: [] }, // SELECT FOR UPDATE (no rows)
        { rows: [] }, // ROLLBACK
      ],
      captured,
    );
    const res = await withdrawAd(client, 'user-1', 'ad-1');
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(captured[2]?.sql).toBe('ROLLBACK');
  });

  it('not_owner: sponsor_id mismatch → ROLLBACK', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // BEGIN
        { rows: [{ sponsor_id: 'someone-else', status: 'approved' }] },
        { rows: [] }, // ROLLBACK
      ],
      captured,
    );
    const res = await withdrawAd(client, 'user-1', 'ad-1');
    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    expect(captured[2]?.sql).toBe('ROLLBACK');
  });

  it('invalid_status: rejected → ROLLBACK', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [] }, { rows: [{ sponsor_id: 'user-1', status: 'rejected' }] }, { rows: [] }],
      captured,
    );
    const res = await withdrawAd(client, 'user-1', 'ad-1');
    expect(res).toEqual({ ok: false, reason: 'invalid_status' });
    expect(captured[2]?.sql).toBe('ROLLBACK');
  });

  it('rolls back and rethrows when UPDATE throws', async () => {
    const captured: CapturedCall[] = [];
    let i = 0;
    const responses = [
      { rows: [] }, // BEGIN
      { rows: [{ sponsor_id: 'user-1', status: 'approved' }] }, // SELECT
    ];
    const client: PgClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (i < responses.length) return responses[i++];
        if (sql.includes('UPDATE ads')) throw new Error('db boom');
        if (sql === 'ROLLBACK') return { rows: [] };
        return { rows: [] };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
    await expect(withdrawAd(client, 'user-1', 'ad-1')).rejects.toThrow('db boom');
    // Last call should be ROLLBACK
    expect(captured[captured.length - 1]?.sql).toBe('ROLLBACK');
  });
});

describe('getAggregateStats', () => {
  it("includes 24h interval clause for period='24h'", async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ impressions: '100', clicks: '10', ad_count: '3' }] }],
      captured,
    );
    const res = await getAggregateStats(client, 'user-1', '24h');
    expect(res).toEqual({ impressions: 100, clicks: 10, ctr: 0.1, adCount: 3 });
    expect(captured[0]?.sql).toContain('ad_stats_daily');
    expect(captured[0]?.sql).toContain('COALESCE(SUM(s.impressions), 0)');
    expect(captured[0]?.sql).toContain('COALESCE(SUM(s.clicks), 0)');
    expect(captured[0]?.sql).toContain("s.day >= now() - interval '24 hours'");
    expect(captured[0]?.params).toEqual(['user-1']);
  });

  it("includes 7d interval clause for period='7d'", async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ impressions: '0', clicks: '0', ad_count: '0' }] }],
      captured,
    );
    await getAggregateStats(client, 'user-1', '7d');
    expect(captured[0]?.sql).toContain('ad_stats_daily');
    expect(captured[0]?.sql).toContain("s.day >= now() - interval '7 days'");
  });

  it("includes 30d interval clause for period='30d'", async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ impressions: '0', clicks: '0', ad_count: '0' }] }],
      captured,
    );
    await getAggregateStats(client, 'user-1', '30d');
    expect(captured[0]?.sql).toContain('ad_stats_daily');
    expect(captured[0]?.sql).toContain("s.day >= now() - interval '30 days'");
  });

  it("omits day condition for period='all'", async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ impressions: '0', clicks: '0', ad_count: '0' }] }],
      captured,
    );
    await getAggregateStats(client, 'user-1', 'all');
    expect(captured[0]?.sql).toContain('ad_stats_daily');
    expect(captured[0]?.sql).not.toContain('interval');
    expect(captured[0]?.sql).not.toContain('s.day >=');
  });

  it('returns ctr=0 when impressions=0 (no divide-by-zero)', async () => {
    const client = mockClient([{ rows: [{ impressions: '0', clicks: '0', ad_count: '5' }] }]);
    const res = await getAggregateStats(client, 'user-1', '7d');
    expect(res.impressions).toBe(0);
    expect(res.clicks).toBe(0);
    expect(res.adCount).toBe(5);
    expect(res.ctr).toBe(0);
  });

  it('handles empty result row gracefully', async () => {
    const client = mockClient([{ rows: [] }]);
    const res = await getAggregateStats(client, 'user-1', 'all');
    expect(res).toEqual({ impressions: 0, clicks: 0, ctr: 0, adCount: 0 });
  });
});
