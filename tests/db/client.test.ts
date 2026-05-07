import { describe, expect, it } from 'vitest';
import { createPgClient } from '../../src/db/client.ts';

describe('createPgClient', () => {
  it('returns an object with end() and a query() method bound to a pool', () => {
    const c = createPgClient('postgres://localhost/test');
    expect(typeof c.query).toBe('function');
    expect(typeof c.end).toBe('function');
  });

  it('throws when url is empty', () => {
    expect(() => createPgClient('')).toThrow(/POSTGRES_URL/);
  });
});
