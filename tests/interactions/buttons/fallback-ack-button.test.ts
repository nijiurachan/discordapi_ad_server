import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import {
  type AckButtonDeps,
  runAckButton,
} from '../../../src/interactions/buttons/fallback-ack-button.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(
  responses: Array<{ rows: unknown[]; rowCount?: number }>,
  captured: CapturedCall[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++];
      if (!r) return { rows: [], rowCount: 0 };
      return { rowCount: r.rowCount ?? r.rows.length, ...r };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

function mockRest(overrides?: Partial<DiscordRest>): DiscordRest {
  return {
    deleteChannel: vi.fn(async () => ({ id: 'chan-1', type: 0 })),
    ...overrides,
  } as unknown as DiscordRest;
}

const FALLBACK_ID = '11111111-1111-1111-1111-111111111111';
const AD_ID = '22222222-2222-2222-2222-222222222222';
const SPONSOR_ID = 'sponsor-1';
const CHANNEL_ID = 'chan-1';

const fallbackDbRow = {
  id: FALLBACK_ID,
  ad_id: AD_ID,
  sponsor_id: SPONSOR_ID,
  channel_id: CHANNEL_ID,
  created_at: new Date('2026-05-01T00:00:00Z'),
  expires_at: new Date('2026-05-15T00:00:00Z'),
  acknowledged_at: null,
};

function buildPayload(overrides?: {
  customId?: string;
  userId?: string;
  noUser?: boolean;
}): MessageComponentInteractionPayload {
  const payload: MessageComponentInteractionPayload = {
    type: 3,
    id: 'int-1',
    application_id: 'app-1',
    guild_id: 'guild-1',
    channel_id: CHANNEL_ID,
    data: {
      custom_id: overrides?.customId ?? `ack:${FALLBACK_ID}`,
      component_type: 2,
    },
  };
  if (!overrides?.noUser) {
    payload.member = {
      user: { id: overrides?.userId ?? SPONSOR_ID, username: 'sponsor' },
      roles: [],
    };
  }
  return payload;
}

async function invoke(
  payload: MessageComponentInteractionPayload,
  deps: AckButtonDeps,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAckButton(c, payload, deps));
  return app.request('http://test/', { method: 'POST' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAckButton', () => {
  it('malformed custom_id (no fallbackId): ephemeral', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const rest = mockRest();
    const res = await invoke(buildPayload({ customId: 'ack:' }), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('不正');
    expect(captured).toHaveLength(0);
    expect(rest.deleteChannel).not.toHaveBeenCalled();
  });

  it('user id missing: ephemeral', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await invoke(buildPayload({ noUser: true }), { rest: mockRest(), client });
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.data.content).toContain('ユーザー情報');
    expect(captured).toHaveLength(0);
  });

  it('fallback not found: ephemeral', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    const rest = mockRest();
    const res = await invoke(buildPayload(), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.data.content).toContain('フォールバック情報が見つかりません');
    expect(rest.deleteChannel).not.toHaveBeenCalled();
  });

  it('already acknowledged: ephemeral 既に確認済み', async () => {
    const captured: CapturedCall[] = [];
    const acked = { ...fallbackDbRow, acknowledged_at: new Date() };
    const client = mockClient([{ rows: [acked] }], captured);
    const rest = mockRest();
    const res = await invoke(buildPayload(), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.data.content).toContain('既に確認済み');
    // Only the SELECT ran.
    expect(captured).toHaveLength(1);
    expect(rest.deleteChannel).not.toHaveBeenCalled();
  });

  it('non-sponsor click (defense in depth): ephemeral permission error', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [fallbackDbRow] }], captured);
    const rest = mockRest();
    const res = await invoke(buildPayload({ userId: 'someone-else' }), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.data.content).toContain('スポンサー');
    // Only the SELECT ran — no UPDATE, no deleteChannel.
    expect(captured).toHaveLength(1);
    expect(rest.deleteChannel).not.toHaveBeenCalled();
  });

  it('happy path: marks ack, sets dm_delivery_status, deletes channel, ephemeral confirmation', async () => {
    const captured: CapturedCall[] = [];
    // Query order:
    //   1) findFallbackById SELECT — row found
    //   2) markFallbackAcknowledged UPDATE
    //   3) setDmDeliveryStatus UPDATE
    const client = mockClient(
      [{ rows: [fallbackDbRow] }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }],
      captured,
    );
    const rest = mockRest();
    const res = await invoke(buildPayload(), { rest, client });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('了解を記録');

    const ackUpdate = captured.find((c) =>
      /UPDATE dm_fallback_channels SET acknowledged_at = now\(\)/.test(c.sql),
    );
    expect(ackUpdate).toBeDefined();
    expect(ackUpdate?.params).toEqual([FALLBACK_ID]);

    const dmUpdate = captured.find((c) => /dm_delivery_status/.test(c.sql));
    expect(dmUpdate).toBeDefined();
    expect(dmUpdate?.params?.[0]).toBe('fallback_acknowledged');
    expect(dmUpdate?.params?.[2]).toBe(AD_ID);

    expect(rest.deleteChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('deleteChannel 404: still returns confirmation (warn logged)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = mockClient([
      { rows: [fallbackDbRow] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const rest = mockRest({
      deleteChannel: vi.fn(async () => {
        throw new DiscordRestError(404, 'unknown channel');
      }),
    });
    const res = await invoke(buildPayload(), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.data.content).toContain('了解を記録');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('deleteChannel non-404 error: still returns confirmation (error logged)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = mockClient([
      { rows: [fallbackDbRow] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const rest = mockRest({
      deleteChannel: vi.fn(async () => {
        throw new DiscordRestError(500, 'server error');
      }),
    });
    const res = await invoke(buildPayload(), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.data.content).toContain('了解を記録');
    expect(errSpy).toHaveBeenCalled();
  });
});
