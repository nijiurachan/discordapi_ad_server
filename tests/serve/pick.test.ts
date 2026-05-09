import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { pickHouseAds, pickPlaceholder, pickRegularAds, serveAds } from '../../src/serve/pick.ts';

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

const REGULAR_ROW = (id: string) => ({
  id,
  kind: 'regular',
  title: `Title ${id}`,
  body: `Body ${id}`,
  link_url: `https://example.com/${id}`,
  image_key: null,
});

const HOUSE_ROW = (id: string) => ({
  id,
  kind: 'house',
  title: `House ${id}`,
  body: `Body ${id}`,
  link_url: `https://example.com/${id}`,
  image_key: 'house/image.png',
});

const PLACEHOLDER_ROW = {
  id: 'placeholder-1',
  kind: 'placeholder',
  title: 'placeholder',
  body: 'no ads available',
  link_url: 'https://example.com',
  image_key: null,
};

describe('pickRegularAds', () => {
  it('returns empty array immediately when n <= 0 (no DB call)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await pickRegularAds(client, 'default', 0);
    expect(res).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it('issues weighted-random ORDER BY and LIMIT, mapping rows to ServedAd', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [REGULAR_ROW('a-1'), REGULAR_ROW('a-2'), REGULAR_ROW('a-3')] }],
      captured,
    );
    const res = await pickRegularAds(client, 'default', 3);
    expect(res).toHaveLength(3);
    expect(res[0]).toEqual({
      id: 'a-1',
      kind: 'regular',
      title: 'Title a-1',
      body: 'Body a-1',
      linkUrl: 'https://example.com/a-1',
      imageKey: null,
    });
    expect(captured[0]?.sql).toMatch(/FROM ads/);
    expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
    expect(captured[0]?.sql).toMatch(/-ln\(random\(\)\) \/ weight_snapshot ASC/);
    expect(captured[0]?.sql).toMatch(/LIMIT \$2/);
    expect(captured[0]?.params).toEqual(['default', 3]);
  });
});

describe('pickHouseAds', () => {
  it('returns empty array immediately when n <= 0', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await pickHouseAds(client, 'default', 0, []);
    expect(res).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it('queries equal-random house rows with kind=house and excludeIds param', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [HOUSE_ROW('h-1'), HOUSE_ROW('h-2')] }], captured);
    const res = await pickHouseAds(client, 'default', 2, ['x-1']);
    expect(res).toHaveLength(2);
    expect(res[0]?.kind).toBe('house');
    expect(captured[0]?.sql).toMatch(/kind = 'house'/);
    expect(captured[0]?.sql).toMatch(/ORDER BY random\(\)/);
    expect(captured[0]?.sql).toMatch(/<> ALL\(\$2::uuid\[\]\)/);
    expect(captured[0]?.params).toEqual(['default', ['x-1'], 2]);
  });
});

describe('pickPlaceholder', () => {
  it('returns single placeholder row when present', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [PLACEHOLDER_ROW] }], captured);
    const res = await pickPlaceholder(client, 'default');
    expect(res).toHaveLength(1);
    expect(res[0]?.kind).toBe('placeholder');
    expect(captured[0]?.sql).toMatch(/kind = 'placeholder'/);
    expect(captured[0]?.sql).toMatch(/LIMIT 1/);
    expect(captured[0]?.params).toEqual(['default']);
  });

  it('returns [] when no placeholder configured', async () => {
    const client = mockClient([{ rows: [] }]);
    const res = await pickPlaceholder(client, 'default');
    expect(res).toEqual([]);
  });
});

describe('serveAds (3-stage fallback)', () => {
  it('returns regulars only when phase 1 fills the quota', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [REGULAR_ROW('a-1'), REGULAR_ROW('a-2'), REGULAR_ROW('a-3')] }],
      captured,
    );
    const res = await serveAds(client, 'default', 3);
    expect(res).toHaveLength(3);
    expect(res.every((a) => a.kind === 'regular')).toBe(true);
    expect(captured).toHaveLength(1); // only phase 1 ran
  });

  it('phase 2 fills with houses when regulars=0', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // regulars
        { rows: [HOUSE_ROW('h-1'), HOUSE_ROW('h-2')] }, // houses
      ],
      captured,
    );
    const res = await serveAds(client, 'default', 2);
    expect(res).toHaveLength(2);
    expect(res.every((a) => a.kind === 'house')).toBe(true);
    expect(captured).toHaveLength(2);
    // house query LIMIT param should equal the unmet shortfall (2)
    expect(captured[1]?.params).toEqual(['default', [], 2]);
  });

  it('phase 1 + phase 2 combined when regulars are partial', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [REGULAR_ROW('a-1')] }, // 1 regular
        { rows: [HOUSE_ROW('h-1'), HOUSE_ROW('h-2')] }, // 2 houses
      ],
      captured,
    );
    const res = await serveAds(client, 'default', 3);
    expect(res).toHaveLength(3);
    expect(res[0]?.kind).toBe('regular');
    expect(res[1]?.kind).toBe('house');
    expect(res[2]?.kind).toBe('house');
    // shortfall passed to house query should be 2
    expect(captured[1]?.params).toEqual(['default', [], 2]);
  });

  it('phase 3 placeholder kicks in when both regular and house are empty', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // regulars
        { rows: [] }, // houses
        { rows: [PLACEHOLDER_ROW] }, // placeholder
      ],
      captured,
    );
    const res = await serveAds(client, 'default', 1);
    expect(res).toHaveLength(1);
    expect(res[0]?.kind).toBe('placeholder');
    expect(captured).toHaveLength(3);
  });

  it('returns [] when all 3 phases empty', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // regulars
        { rows: [] }, // houses
        { rows: [] }, // placeholder
      ],
      captured,
    );
    const res = await serveAds(client, 'default', 1);
    expect(res).toEqual([]);
    expect(captured).toHaveLength(3);
  });

  it('clamps n=0 up to 1', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [REGULAR_ROW('a-1')] }], captured);
    const res = await serveAds(client, 'default', 0);
    expect(res).toHaveLength(1);
    // Phase 1 query LIMIT param should be 1 (clamped from 0)
    expect(captured[0]?.params).toEqual(['default', 1]);
  });

  it('clamps n=10 down to 5', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        {
          rows: [
            REGULAR_ROW('a-1'),
            REGULAR_ROW('a-2'),
            REGULAR_ROW('a-3'),
            REGULAR_ROW('a-4'),
            REGULAR_ROW('a-5'),
          ],
        },
      ],
      captured,
    );
    const res = await serveAds(client, 'default', 10);
    expect(res).toHaveLength(5);
    expect(captured[0]?.params).toEqual(['default', 5]);
  });
});
