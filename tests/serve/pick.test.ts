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
  weight_snapshot: 1,
  sponsor_id: null,
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

  it('queries the regular deck (ORDER BY id) and maps rows to ServedAd', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [REGULAR_ROW('a-1'), REGULAR_ROW('a-2'), REGULAR_ROW('a-3')] },
        { rows: [{ bag: JSON.stringify(['a-1', 'a-2', 'a-3']), cursor: 3 }] }, // rotation upsert
      ],
      captured,
    );
    const res = await pickRegularAds(client, 'default', 3);
    expect(res).toHaveLength(3);
    expect(res.map((a) => a.id).sort()).toEqual(['a-1', 'a-2', 'a-3']);
    const a1 = res.find((a) => a.id === 'a-1');
    expect(a1).toEqual({
      id: 'a-1',
      kind: 'regular',
      title: 'Title a-1',
      body: 'Body a-1',
      linkUrl: 'https://example.com/a-1',
      imageKey: null,
    });
    expect(captured[0]?.sql).toMatch(/FROM ads/);
    expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
    expect(captured[0]?.sql).toMatch(/ORDER BY id/);
    expect(captured[0]?.params).toEqual(['default']);
  });
});

describe('pickRegularAds sponsor_id', () => {
  it('selects sponsor_id in the regular deck query', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        {
          rows: [
            { ...REGULAR_ROW('a-1'), sponsor_id: 'A', weight_snapshot: 1 },
            { ...REGULAR_ROW('a-2'), sponsor_id: 'A', weight_snapshot: 1 },
          ],
        },
        { rows: [{ bag: JSON.stringify(['a-1', 'a-2']), cursor: 1 }] }, // rotation upsert
      ],
      captured,
    );
    await pickRegularAds(client, 'default', 1);
    expect(captured[0]?.sql).toMatch(/sponsor_id/);
  });

  it('share invariance: deck still contains each ad weight_snapshot times', async () => {
    const captured: CapturedCall[] = [];
    let capturedBag: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (/SELECT id, kind/.test(sql)) {
          return {
            rows: [
              { ...REGULAR_ROW('a-1'), sponsor_id: 'A', weight_snapshot: 3 },
              { ...REGULAR_ROW('b-1'), sponsor_id: 'B', weight_snapshot: 1 },
            ],
          };
        }
        // rotation upsert: echo back the bag we were given so we can inspect it.
        const bagArg = params?.[2];
        if (typeof bagArg === 'string') capturedBag = JSON.parse(bagArg);
        return { rows: [{ bag: bagArg, cursor: 1 }] };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    } as PgClient;
    await pickRegularAds(client, 'default', 1);
    const counts = capturedBag.reduce<Record<string, number>>((m, id) => {
      m[id] = (m[id] ?? 0) + 1;
      return m;
    }, {});
    expect(counts['a-1']).toBe(3);
    expect(counts['b-1']).toBe(1);
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
    expect(captured[0]?.sql).toMatch(/NOT IN \(\?\)/);
    expect(captured[0]?.params).toEqual(['default', 'x-1', 2]);
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
      [
        { rows: [REGULAR_ROW('a-1'), REGULAR_ROW('a-2'), REGULAR_ROW('a-3')] },
        { rows: [{ bag: JSON.stringify(['a-1', 'a-2', 'a-3']), cursor: 3 }] }, // rotation upsert
      ],
      captured,
    );
    const res = await serveAds(client, 'default', 3);
    expect(res).toHaveLength(3);
    expect(res.every((a) => a.kind === 'regular')).toBe(true);
    // phase 1 = regular SELECT + rotation upsert; phase 2 did not run.
    expect(captured).toHaveLength(2);
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
    // house query LIMIT param should equal the unmet shortfall (2); empty
    // exclude list omits the NOT IN clause, so params are just [slot, n].
    expect(captured[1]?.params).toEqual(['default', 2]);
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
    // shortfall passed to house query should be 2 (empty exclude omits NOT IN).
    expect(captured[1]?.params).toEqual(['default', 2]);
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
    // Deck SELECT is parameterized only by slot; n is applied via the cursor,
    // not a LIMIT bind. The clamp from 0 -> 1 is observed via the single result.
    expect(captured[0]?.params).toEqual(['default']);
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
        {
          rows: [{ bag: JSON.stringify(['a-1', 'a-2', 'a-3', 'a-4', 'a-5']), cursor: 5 }],
        }, // rotation upsert: cursor advanced by the clamped n=5
      ],
      captured,
    );
    const res = await serveAds(client, 'default', 10);
    expect(res).toHaveLength(5);
    // Deck SELECT is parameterized only by slot; the clamp 10 -> 5 is observed
    // via the cursor advance (upsert bind position 4) and the 5 returned ads.
    expect(captured[0]?.params).toEqual(['default']);
    expect(captured[1]?.params?.[3]).toBe(5);
  });
});
