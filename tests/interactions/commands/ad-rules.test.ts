import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { Bindings } from '../../../src/env.ts';
import { runAdRules } from '../../../src/interactions/commands/ad-rules.ts';

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

async function invoke(client: PgClient, slot: string): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAdRules(c, slot, { client }));
  return app.request('http://test/', { method: 'POST' });
}

const fullRulesRow = {
  slot: 'default',
  allowedMimes: ['image/png', 'image/jpeg'],
  allowedExtensions: ['png', 'jpg'],
  maxBytes: 5_242_880,
  minWidth: 200,
  maxWidth: 2000,
  minHeight: 200,
  maxHeight: 2000,
  aspectRatios: ['1:1', '16:9'],
  aspectTolerance: 0.02,
  titleMaxLen: 80,
  bodyMaxLen: 500,
  linkUrlMaxLen: 2048,
  linkScheme: ['https'],
  linkDomainAllowlist: null,
  linkDomainBlocklist: null,
};

describe('runAdRules', () => {
  it('rules present → renders title/body/link rules ephemerally', async () => {
    const client = mockClient([{ rows: [fullRulesRow] }]);
    const res = await invoke(client, 'default');
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('入稿ルール');
    expect(json.data.content).toContain('image/png, image/jpeg');
    expect(json.data.content).toContain('5.0 MB');
    expect(json.data.content).toContain('1:1 / 16:9');
    expect(json.data.content).toContain('80 文字');
    expect(json.data.content).toContain('500 文字');
    expect(json.data.content).toContain('https');
  });

  it('rules missing → ephemeral "未設定"', async () => {
    const client = mockClient([{ rows: [] }]);
    const res = await invoke(client, 'unknown');
    const json = (await res.json()) as { data: { content: string; flags: number } };
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('未設定');
    expect(json.data.content).toContain('unknown');
  });

  it('aspectRatios=null → "なし"', async () => {
    const client = mockClient([{ rows: [{ ...fullRulesRow, aspectRatios: null }] }]);
    const res = await invoke(client, 'default');
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toContain('なし');
  });
});
