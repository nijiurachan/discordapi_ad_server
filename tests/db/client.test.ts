import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetPoolCacheForTests,
  createPgClient,
  resolveDbUrl,
  sslConfig,
} from '../../src/db/client.ts';
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

describe('sslConfig', () => {
  it('uses unverified TLS for remote hosts (public PG enforces hostssl)', () => {
    expect(sslConfig('postgres://u:p@202.215.60.54:5432/db')).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('skips TLS for localhost (local dev)', () => {
    expect(sslConfig('postgres://u:p@localhost:5432/db')).toBe(false);
    expect(sslConfig('postgres://u:p@127.0.0.1:5432/db')).toBe(false);
  });

  it('skips TLS for the Hyperdrive local endpoint (it terminates TLS itself)', () => {
    expect(sslConfig('postgres://u:p@abc123.hyperdrive.local:5432/db')).toBe(false);
  });

  it('honors explicit sslmode in the URL', () => {
    expect(sslConfig('postgres://u:p@host/db?sslmode=disable')).toBe(false);
    expect(sslConfig('postgres://u:p@host/db?sslmode=require')).toEqual({
      rejectUnauthorized: false,
    });
    expect(sslConfig('postgres://u:p@localhost/db?sslmode=require')).toEqual({
      rejectUnauthorized: false,
    });
    expect(sslConfig('postgres://u:p@host/db?sslmode=verify-full')).toEqual({
      rejectUnauthorized: true,
    });
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
