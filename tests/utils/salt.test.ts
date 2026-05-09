import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { getDailySalt } from '../../src/utils/salt.ts';

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

describe('getDailySalt', () => {
  it('returns fallback when no row exists', async () => {
    const client = mockClient([{ rows: [] }]);
    const out = await getDailySalt(client, 'bootstrap-salt');
    expect(out).toBe('bootstrap-salt');
  });

  it('returns the salt when row has valid { salt: "abcd" }', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ value: { salt: 'abcd' } }] }], captured);
    const out = await getDailySalt(client, 'bootstrap-salt');
    expect(out).toBe('abcd');
    expect(captured[0]?.params).toEqual(['ip_hash_salt']);
  });

  it('returns fallback when JSON shape has no salt key', async () => {
    const client = mockClient([{ rows: [{ value: { other: 'whatever' } }] }]);
    const out = await getDailySalt(client, 'bootstrap-salt');
    expect(out).toBe('bootstrap-salt');
  });

  it('returns fallback when salt is empty string', async () => {
    const client = mockClient([{ rows: [{ value: { salt: '' } }] }]);
    const out = await getDailySalt(client, 'bootstrap-salt');
    expect(out).toBe('bootstrap-salt');
  });
});
