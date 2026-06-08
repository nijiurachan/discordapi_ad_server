import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import {
  insertAdEvent,
  insertEventIfNotRecent,
  isRecentEvent,
} from '../../../src/db/queries/ad-events.ts';

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

describe('isRecentEvent', () => {
  it('issues SELECT EXISTS with adId, ipHash, eventType, secs', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ exists: true }] }], captured);
    const out = await isRecentEvent(client, 'ad-1', 'iphash', 'impression');
    expect(out).toBe(true);
    expect(captured[0]?.sql).toMatch(/SELECT EXISTS/);
    expect(captured[0]?.sql).toMatch(/FROM ad_events/);
    expect(captured[0]?.sql).toMatch(/ad_id = \?/);
    expect(captured[0]?.sql).toMatch(/ip_hash = \?/);
    expect(captured[0]?.sql).toMatch(/event_type = \?/);
    expect(captured[0]?.sql).toMatch(/ts > \(unixepoch\(\) \* 1000\) - \?/);
    // SQLite impl compares against epoch-ms; windowMs (default 5min) is passed as-is.
    expect(captured[0]?.params).toEqual(['ad-1', 'iphash', 'impression', 300000]);
  });

  it('returns true when EXISTS row is true', async () => {
    const client = mockClient([{ rows: [{ exists: true }] }]);
    const out = await isRecentEvent(client, 'ad-1', 'iphash', 'click');
    expect(out).toBe(true);
  });

  it('returns false when no row matches', async () => {
    const client = mockClient([{ rows: [{ exists: false }] }]);
    const out = await isRecentEvent(client, 'ad-1', 'iphash', 'click');
    expect(out).toBe(false);
  });

  it('returns false when result row is missing entirely', async () => {
    const client = mockClient([{ rows: [] }]);
    const out = await isRecentEvent(client, 'ad-1', 'iphash', 'click');
    expect(out).toBe(false);
  });

  it('passes custom windowMs (60000) through as epoch-ms', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ exists: false }] }], captured);
    await isRecentEvent(client, 'ad-1', 'iphash', 'impression', 60000);
    expect(captured[0]?.params).toEqual(['ad-1', 'iphash', 'impression', 60000]);
  });

  it('passes windowMs=0 through unchanged', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ exists: false }] }], captured);
    await isRecentEvent(client, 'ad-1', 'iphash', 'impression', 0);
    expect(captured[0]?.params).toEqual(['ad-1', 'iphash', 'impression', 0]);
  });

  it('passes small windowMs (100ms) through as epoch-ms', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ exists: false }] }], captured);
    await isRecentEvent(client, 'ad-1', 'iphash', 'impression', 100);
    expect(captured[0]?.params).toEqual(['ad-1', 'iphash', 'impression', 100]);
  });
});

describe('insertAdEvent', () => {
  it('issues INSERT INTO ad_events with all fields', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    await insertAdEvent(client, {
      adId: 'ad-1',
      eventType: 'impression',
      ipHash: 'iphash',
      ua: 'Mozilla/5.0',
      slot: 'default',
    });
    expect(captured[0]?.sql).toMatch(/INSERT INTO ad_events/);
    expect(captured[0]?.sql).toMatch(/\(ad_id, event_type, ip_hash, ua, slot\)/);
    expect(captured[0]?.params).toEqual(['ad-1', 'impression', 'iphash', 'Mozilla/5.0', 'default']);
  });

  it('passes null ipHash and null ua through', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    await insertAdEvent(client, {
      adId: 'ad-1',
      eventType: 'click',
      ipHash: null,
      ua: null,
      slot: null,
    });
    expect(captured[0]?.params).toEqual(['ad-1', 'click', null, null, null]);
  });
});

describe('insertEventIfNotRecent', () => {
  it('returns ok=true with insertedId on happy path and captures all 9 params', async () => {
    const captured: CapturedCall[] = [];
    // SQLite impl is a single atomic INSERT ... SELECT ... WHERE NOT EXISTS statement;
    // no BEGIN / advisory lock / COMMIT (D1 has no interactive tx).
    const client = mockClient([{ rows: [{ id: '42' }] }], captured);
    const out = await insertEventIfNotRecent(client, {
      adId: 'ad-1',
      eventType: 'impression',
      ipHash: 'iphash',
      ua: 'Mozilla/5.0',
      slot: 'default',
    });
    expect(out).toEqual({ ok: true, insertedId: 42n });
    // The INSERT is the only query.
    expect(captured[0]?.sql).toMatch(/INSERT INTO ad_events/);
    expect(captured[0]?.sql).toMatch(/WHERE NOT EXISTS/);
    expect(captured[0]?.sql).toMatch(/ts > \(unixepoch\(\) \* 1000\) - \?/);
    expect(captured[0]?.sql).toMatch(/RETURNING id/);
    expect(captured[0]?.params).toEqual([
      'ad-1',
      'impression',
      'iphash',
      'Mozilla/5.0',
      'default',
      'ad-1',
      'iphash',
      'impression',
      300000,
    ]);
  });

  it('issues a single INSERT statement without BEGIN/lock/COMMIT', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ id: '7' }] }], captured);
    await insertEventIfNotRecent(client, {
      adId: 'ad-1',
      eventType: 'click',
      ipHash: 'iphash',
      ua: null,
      slot: null,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/INSERT INTO ad_events/);
    expect(captured[0]?.sql).toMatch(/WHERE NOT EXISTS/);
  });

  it('returns ok=false reason=duplicate when no row inserted', async () => {
    // INSERT returns no rows → suppressed by dedup window → duplicate.
    const client = mockClient([{ rows: [] }]);
    const out = await insertEventIfNotRecent(client, {
      adId: 'ad-1',
      eventType: 'click',
      ipHash: 'iphash',
      ua: null,
      slot: null,
    });
    expect(out).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('passes custom windowMs (60000) through as epoch-ms in SQL params', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ id: '1' }] }], captured);
    await insertEventIfNotRecent(
      client,
      {
        adId: 'ad-1',
        eventType: 'impression',
        ipHash: 'iphash',
        ua: null,
        slot: null,
      },
      60000,
    );
    expect(captured[0]?.params?.[8]).toBe(60000);
  });

  it('passes windowMs=0 through unchanged', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ id: '1' }] }], captured);
    await insertEventIfNotRecent(
      client,
      {
        adId: 'ad-1',
        eventType: 'impression',
        ipHash: 'iphash',
        ua: null,
        slot: null,
      },
      0,
    );
    expect(captured[0]?.params?.[8]).toBe(0);
  });

  it('rethrows when the INSERT throws (no rollback needed — single statement)', async () => {
    const captured: CapturedCall[] = [];
    const client: PgClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (sql.includes('INSERT INTO ad_events')) {
          throw new Error('insert boom');
        }
        return { rows: [] };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
    await expect(
      insertEventIfNotRecent(client, {
        adId: 'ad-1',
        eventType: 'impression',
        ipHash: 'iphash',
        ua: null,
        slot: null,
      }),
    ).rejects.toThrow('insert boom');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/INSERT INTO ad_events/);
  });
});
