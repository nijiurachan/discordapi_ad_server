import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { Bindings } from '../../../src/env.ts';
import { runAdWithdraw } from '../../../src/interactions/commands/ad-withdraw.ts';

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

async function invoke(client: PgClient, userId: string, adId: string): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAdWithdraw(c, userId, adId, { client }));
  return app.request('http://test/', { method: 'POST' });
}

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

describe('runAdWithdraw', () => {
  it('happy path: returns ephemeral success', async () => {
    const client = mockClient([
      { rows: [] }, // BEGIN
      { rows: [{ sponsor_id: 'user-1', status: 'approved' }] },
      { rows: [] }, // UPDATE
      { rows: [] }, // INSERT
      { rows: [] }, // COMMIT
    ]);
    const res = await invoke(client, 'user-1', VALID_UUID);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('取り下げました');
  });

  it('not_found → "広告が見つかりません"', async () => {
    const client = mockClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // SELECT (no rows)
      { rows: [] }, // ROLLBACK
    ]);
    const res = await invoke(client, 'user-1', VALID_UUID);
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toContain('見つかりません');
  });

  it('not_owner → "取り下げ権限がありません"', async () => {
    const client = mockClient([
      { rows: [] },
      { rows: [{ sponsor_id: 'someone-else', status: 'approved' }] },
      { rows: [] },
    ]);
    const res = await invoke(client, 'user-1', VALID_UUID);
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toContain('取り下げ権限');
  });

  it('invalid_status → "現在のステータスでは取り下げできません"', async () => {
    const client = mockClient([
      { rows: [] },
      { rows: [{ sponsor_id: 'user-1', status: 'rejected' }] },
      { rows: [] },
    ]);
    const res = await invoke(client, 'user-1', VALID_UUID);
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toContain('現在のステータス');
  });

  it('invalid uuid format → ephemeral validation error, no DB call', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await invoke(client, 'user-1', 'not-a-uuid');
    const json = (await res.json()) as { data: { content: string; flags: number } };
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('広告 ID');
    expect(captured).toHaveLength(0);
  });

  it('empty adId → ephemeral validation error', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await invoke(client, 'user-1', '');
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toContain('広告 ID');
    expect(captured).toHaveLength(0);
  });
});
