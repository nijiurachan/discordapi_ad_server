import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type { ApplicationCommandInteractionPayload } from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import { type AdSetupDeps, runAdSetup } from '../../../src/interactions/commands/ad-setup.ts';

// --- helpers --------------------------------------------------------------

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

function buildPayload(overrides?: {
  channel?: string | undefined;
  kind?: string | undefined;
  omitChannel?: boolean;
  omitKind?: boolean;
  permissions?: string;
}): ApplicationCommandInteractionPayload {
  const channel = overrides?.channel ?? 'chan-target';
  const kind = overrides?.kind ?? 'submit';
  const permissions = overrides?.permissions ?? '8'; // ADMINISTRATOR
  const options: { name: string; type: number; value: string }[] = [];
  if (!overrides?.omitChannel) {
    options.push({ name: 'channel', type: 7, value: channel });
  }
  if (!overrides?.omitKind) {
    options.push({ name: 'kind', type: 3, value: kind });
  }
  return {
    type: 2,
    id: 'int-1',
    application_id: 'app-1',
    guild_id: 'guild-1',
    channel_id: 'chan-1',
    member: { user: { id: 'admin-1', username: 'admin' }, roles: [], permissions },
    data: {
      id: 'cmd-1',
      name: 'ad-setup',
      type: 1,
      options,
    },
  };
}

async function invoke(
  payload: ApplicationCommandInteractionPayload,
  deps: AdSetupDeps,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAdSetup(c, payload, deps));
  return app.request('http://test/', { method: 'POST' });
}

// --- tests ----------------------------------------------------------------

describe('runAdSetup', () => {
  it('happy path: posts menu, persists message_id + channel_id, ephemeral confirm', async () => {
    const captured: CapturedCall[] = [];
    // 1) get old message_id (none)  2) get old channel_id (none)
    // 3) set message_id              4) set channel_id
    const client = mockClient(
      [
        { rows: [] }, // old message_id missing
        { rows: [] }, // old channel_id missing
        { rows: [] }, // upsert message_id
        { rows: [] }, // upsert channel_id
      ],
      captured,
    );
    const createMessage = vi.fn(async () => ({ id: 'msg-new', channel_id: 'chan-target' }));
    const deleteMessage = vi.fn(async () => undefined);
    const rest = { createMessage, deleteMessage } as unknown as DiscordRest;

    const res = await invoke(buildPayload(), { rest, client, actorId: 'admin-1' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('<#chan-target>');

    // createMessage was called with submit menu
    expect(createMessage).toHaveBeenCalledTimes(1);
    const call = createMessage.mock.calls[0] as unknown as [string, unknown];
    const postedChannel = call[0];
    const postedBody = call[1];
    expect(postedChannel).toBe('chan-target');
    const body = postedBody as { content: string; components: unknown[] };
    expect(body.content).toContain('広告起稿');
    expect(body.components).toHaveLength(1);
    const row = body.components[0] as { type: number; components: unknown[] };
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(4);

    // deleteMessage was NOT called (no old menu)
    expect(deleteMessage).not.toHaveBeenCalled();

    // Last two queries are the UPSERTs with the new ids
    const upsertCalls = captured.filter((c) => /INSERT INTO system_settings/.test(c.sql));
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0]?.params).toEqual([
      'menu.submit.message_id',
      JSON.stringify('msg-new'),
      'admin-1',
    ]);
    expect(upsertCalls[1]?.params).toEqual([
      'menu.submit.channel_id',
      JSON.stringify('chan-target'),
      'admin-1',
    ]);
  });

  it('old menu exists: deletes first, then posts new, then persists', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [{ value: 'msg-old' }] }, // old message_id
        { rows: [{ value: 'chan-old' }] }, // old channel_id
        { rows: [] }, // upsert message_id
        { rows: [] }, // upsert channel_id
      ],
      captured,
    );
    const createMessage = vi.fn(async () => ({ id: 'msg-new', channel_id: 'chan-target' }));
    const deleteMessage = vi.fn(async () => undefined);
    const rest = { createMessage, deleteMessage } as unknown as DiscordRest;

    const res = await invoke(buildPayload(), { rest, client, actorId: 'admin-1' });
    expect(res.status).toBe(200);

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith('chan-old', 'msg-old');
    expect(createMessage).toHaveBeenCalledTimes(1);

    // delete must come before createMessage
    const deleteOrder = deleteMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const createOrder = createMessage.mock.invocationCallOrder[0] ?? -1;
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it('old menu delete fails (404): swallowed, still posts new', async () => {
    const client = mockClient([
      { rows: [{ value: 'msg-old' }] }, // old message_id
      { rows: [{ value: 'chan-old' }] }, // old channel_id
      { rows: [] }, // upsert message_id
      { rows: [] }, // upsert channel_id
    ]);
    const createMessage = vi.fn(async () => ({ id: 'msg-new', channel_id: 'chan-target' }));
    const deleteMessage = vi.fn(async () => {
      throw new Error('discord 404');
    });
    const rest = { createMessage, deleteMessage } as unknown as DiscordRest;

    // Suppress expected console.warn
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await invoke(buildPayload(), { rest, client, actorId: 'admin-1' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { type: number; data: { content: string } };
      expect(json.type).toBe(4);
      expect(json.data.content).toContain('<#chan-target>');
      expect(deleteMessage).toHaveBeenCalledTimes(1);
      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('kind=review: ephemeral coming-soon stub', async () => {
    const client = mockClient([]);
    const createMessage = vi.fn(async () => ({ id: 'x', channel_id: 'y' }));
    const deleteMessage = vi.fn(async () => undefined);
    const rest = { createMessage, deleteMessage } as unknown as DiscordRest;

    const res = await invoke(buildPayload({ kind: 'review' }), {
      rest,
      client,
      actorId: 'admin-1',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('review');
    expect(json.data.content).toContain('後続フェーズ');
    expect(createMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('kind=admin: posts admin menu and persists message/channel ids', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // old admin message_id missing
        { rows: [] }, // old admin channel_id missing
        { rows: [] }, // upsert message_id
        { rows: [] }, // upsert channel_id
      ],
      captured,
    );
    type MenuBody = {
      embeds: Array<{ title: string }>;
      components: Array<{ components: unknown[] }>;
    };
    const createMessage = vi.fn(async (_channelId: string, _body: MenuBody) => ({
      id: 'admin-msg',
      channel_id: 'chan-target',
    }));
    const deleteMessage = vi.fn(async (_channelId: string, _messageId: string) => undefined);
    const rest = { createMessage, deleteMessage } as unknown as DiscordRest;

    const res = await invoke(buildPayload({ kind: 'admin' }), {
      rest,
      client,
      actorId: 'admin-1',
    });
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('admin');
    expect(createMessage).toHaveBeenCalledTimes(1);
    const menuBody = createMessage.mock.calls[0]?.[1];
    expect(menuBody).toBeDefined();
    if (!menuBody) throw new Error('createMessage should have been called');
    expect(menuBody.embeds[0]?.title).toContain('広告管理コンソール');
    const totalButtons = menuBody.components.reduce((acc, row) => acc + row.components.length, 0);
    expect(totalButtons).toBe(16);

    // The two trailing UPSERTs persist the new admin menu's message/channel ids.
    const upsertCalls = captured.filter((c) => /INSERT INTO system_settings/.test(c.sql));
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0]?.params).toEqual([
      'menu.admin.message_id',
      JSON.stringify('admin-msg'),
      'admin-1',
    ]);
    expect(upsertCalls[1]?.params).toEqual([
      'menu.admin.channel_id',
      JSON.stringify('chan-target'),
      'admin-1',
    ]);
  });

  it('missing channel option: ephemeral validation error', async () => {
    const client = mockClient([]);
    const createMessage = vi.fn(async () => ({ id: 'x', channel_id: 'y' }));
    const deleteMessage = vi.fn(async () => undefined);
    const rest = { createMessage, deleteMessage } as unknown as DiscordRest;

    const res = await invoke(buildPayload({ omitChannel: true }), {
      rest,
      client,
      actorId: 'admin-1',
    });
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('channel');
    expect(json.data.content).toContain('kind');
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('missing kind option: ephemeral validation error', async () => {
    const client = mockClient([]);
    const createMessage = vi.fn(async () => ({ id: 'x', channel_id: 'y' }));
    const deleteMessage = vi.fn(async () => undefined);
    const rest = { createMessage, deleteMessage } as unknown as DiscordRest;

    const res = await invoke(buildPayload({ omitKind: true }), {
      rest,
      client,
      actorId: 'admin-1',
    });
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('channel');
    expect(json.data.content).toContain('kind');
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('rejects non-admin invocations (permissions=0)', async () => {
    const client = mockClient([]);
    const createMessage = vi.fn(async () => ({ id: 'x', channel_id: 'y' }));
    const deleteMessage = vi.fn(async () => undefined);
    const rest = { createMessage, deleteMessage } as unknown as DiscordRest;

    const res = await invoke(buildPayload({ permissions: '0' }), {
      rest,
      client,
      actorId: 'admin-1',
    });
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('Administrator');
    expect(createMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
