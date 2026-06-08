import { describe, expect, it, vi } from 'vitest';
import { rotateDailySalt } from '../../src/cron/rotate-salt.ts';
import type { PgClient } from '../../src/db/client.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(
  responses: Array<{ rows?: unknown[]; rowCount?: number }>,
  captured: Capture[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++] ?? {};
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('rotateDailySalt', () => {
  it('issues an atomic INSERT...ON CONFLICT that copies prior salt to previous', async () => {
    const captured: Capture[] = [];
    const client = mockClient([{ rows: [{ had_previous: 1 }] }], captured);
    const result = await rotateDailySalt(client, { actorId: 'cron' });
    expect(result.newSaltLength).toBe(64);
    expect(result.hadPrevious).toBe(true);

    const { sql, params } = captured[0] ?? { sql: '', params: [] };
    expect(sql).toMatch(/INSERT INTO system_settings/);
    expect(sql).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(sql).toMatch(/json_extract\(system_settings\.value, '\$\.salt'\)/);
    expect(sql).toMatch(/RETURNING/);
    expect(params?.[0]).toBe('ip_hash_salt');
    // params[1] is the JSON value text inserted on first-ever write
    // ({ salt, previous: null }); the new 64-char hex salt is params[3],
    // also bound into the ON CONFLICT json_object('salt', ?).
    expect(typeof params?.[1]).toBe('string');
    expect(JSON.parse(params?.[1] as string)).toEqual({
      salt: expect.any(String),
      previous: null,
    });
    expect(params?.[2]).toBe('cron');
    expect(typeof params?.[3]).toBe('string');
    expect((params?.[3] as string).length).toBe(64);
  });

  it('defaults actorId to "system" when omitted', async () => {
    const captured: Capture[] = [];
    const client = mockClient([{ rows: [{ had_previous: 0 }] }], captured);
    await rotateDailySalt(client);
    expect(captured[0]?.params?.[2]).toBe('system');
  });

  it('reports hadPrevious=false on first-ever insert', async () => {
    const client = mockClient([{ rows: [{ had_previous: 0 }] }]);
    const result = await rotateDailySalt(client);
    expect(result.hadPrevious).toBe(false);
  });
});
