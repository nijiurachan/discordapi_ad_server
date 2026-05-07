import { afterEach, describe, expect, it } from 'vitest';
import { createPgClient } from '../../src/db/client.ts';

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
});
