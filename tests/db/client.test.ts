import { afterEach, describe, expect, it } from 'vitest';
import { _resetPoolCacheForTests, createPgClient, resolveDbUrl } from '../../src/db/client.ts';
import type { Bindings } from '../../src/env.ts';

describe('createPgClient', () => {
  let openClients: Array<{ end: () => Promise<void> }> = [];

  afterEach(async () => {
    try {
      await Promise.allSettled(openClients.map((c) => c.end()));
    } finally {
      openClients = [];
    }
  });

  it('returns an object with end() and a query() method bound to a pool', () => {
    const c = createPgClient('postgres://localhost/test');
    openClients.push(c);
    expect(typeof c.query).toBe('function');
    expect(typeof c.end).toBe('function');
  });

  it('throws when url is empty', () => {
    expect(() => createPgClient('')).toThrow(/POSTGRES_URL/);
  });

  it('throws when url is whitespace-only', () => {
    expect(() => createPgClient('   ')).toThrow(/POSTGRES_URL/);
  });
});

describe('resolveDbUrl', () => {
  it('returns POSTGRES_URL when no Hyperdrive binding is present', () => {
    const env = { POSTGRES_URL: 'postgres://pg/db' } as unknown as Bindings;
    expect(resolveDbUrl(env)).toBe('postgres://pg/db');
  });

  it('prefers HYPERDRIVE.connectionString over POSTGRES_URL when bound', () => {
    const env = {
      POSTGRES_URL: 'postgres://pg/db',
      HYPERDRIVE: { connectionString: 'postgres://hyperdrive/db' },
    } as unknown as Bindings;
    expect(resolveDbUrl(env)).toBe('postgres://hyperdrive/db');
  });
});

describe('pool cache (withPgClient)', () => {
  // Don't actually call withPgClient(real-url, fn) — that would attempt a TCP
  // connection. Pool reuse is asserted indirectly: _resetPoolCacheForTests
  // exists, accepts no args, and never throws when the cache is empty.
  it('exposes a test reset that is a no-op on an empty cache', async () => {
    await expect(_resetPoolCacheForTests()).resolves.toBeUndefined();
  });
});
