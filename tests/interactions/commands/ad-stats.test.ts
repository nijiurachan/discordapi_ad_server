import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { Bindings } from '../../../src/env.ts';
import {
  periodSelectMenuResponse,
  runAdStats,
} from '../../../src/interactions/commands/ad-stats.ts';

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

async function invokeStats(
  client: PgClient,
  userId: string,
  period: '24h' | '7d' | '30d' | 'all',
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAdStats(c, userId, period, { client }));
  return app.request('http://test/', { method: 'POST' });
}

async function invokeMenu(): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => periodSelectMenuResponse(c));
  return app.request('http://test/', { method: 'POST' });
}

describe('periodSelectMenuResponse', () => {
  it('returns 4 buttons (24h/7d/30d/all) ephemeral', async () => {
    const res = await invokeMenu();
    const json = (await res.json()) as {
      type: number;
      data: {
        content: string;
        flags: number;
        components: { components: { custom_id: string; label: string }[] }[];
      };
    };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('期間');
    expect(json.data.components).toHaveLength(1);
    const buttons = json.data.components[0]?.components;
    expect(buttons).toHaveLength(4);
    expect(buttons?.map((b) => b.custom_id)).toEqual([
      'ad:stats:24h',
      'ad:stats:7d',
      'ad:stats:30d',
      'ad:stats:all',
    ]);
  });
});

describe('runAdStats', () => {
  it('24h: queries with 24h interval clause and renders stats', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ impressions: '100', clicks: '5', ad_count: '2' }] }],
      captured,
    );
    const res = await invokeStats(client, 'user-1', '24h');
    const json = (await res.json()) as { data: { content: string; flags: number } };
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('直近 24 時間');
    expect(json.data.content).toContain('インプレッション: 100');
    expect(json.data.content).toContain('クリック: 5');
    expect(json.data.content).toContain('CTR: 5.00%');
    expect(captured[0]?.sql).toContain("interval '24 hours'");
  });

  it('7d: includes 7 days interval', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ impressions: '0', clicks: '0', ad_count: '0' }] }],
      captured,
    );
    await invokeStats(client, 'user-1', '7d');
    expect(captured[0]?.sql).toContain("interval '7 days'");
  });

  it('30d: includes 30 days interval', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ impressions: '0', clicks: '0', ad_count: '0' }] }],
      captured,
    );
    await invokeStats(client, 'user-1', '30d');
    expect(captured[0]?.sql).toContain("interval '30 days'");
  });

  it('all: omits interval clause', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [{ impressions: '0', clicks: '0', ad_count: '0' }] }],
      captured,
    );
    await invokeStats(client, 'user-1', 'all');
    expect(captured[0]?.sql).not.toContain('interval');
  });

  it('0 impressions → CTR 0.00%, no divide-by-zero', async () => {
    const client = mockClient([{ rows: [{ impressions: '0', clicks: '0', ad_count: '3' }] }]);
    const res = await invokeStats(client, 'user-1', '7d');
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toContain('CTR: 0.00%');
    expect(json.data.content).toContain('広告数: 3');
  });
});
