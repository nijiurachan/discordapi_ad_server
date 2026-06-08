import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type { ApplicationCommandInteractionPayload } from '../../../src/discord/types.ts';
import { runAdSetup } from '../../../src/interactions/commands/ad-setup.ts';

function payload(): ApplicationCommandInteractionPayload {
  return {
    type: 2,
    id: 'i',
    application_id: 'app',
    member: { user: { id: 'admin-1' }, permissions: '8' }, // ADMINISTRATOR
    data: {
      id: 'd',
      name: 'ad-setup',
      type: 1,
      options: [
        { name: 'channel', type: 7, value: 'chan-1' },
        { name: 'kind', type: 3, value: 'portal' },
      ],
    },
  } as unknown as ApplicationCommandInteractionPayload;
}

describe('ad-setup kind:portal', () => {
  it('posts a panel with a portal:open button and persists message/channel id', async () => {
    const captured: { sql: string; params: unknown[] | undefined }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
      end: vi.fn(),
    } as unknown as PgClient;
    const rest = {
      createMessage: vi.fn(async () => ({ id: 'panel-msg-1', channel_id: 'chan-1' })),
      deleteMessage: vi.fn(),
    } as unknown as DiscordRest;

    const app = new Hono();
    app.post('/', (c) => runAdSetup(c, payload(), { rest, client, actorId: 'admin-1' }));
    const res = await app.request('/', { method: 'POST' });
    expect(res.status).toBe(200);

    const [, body] = (rest.createMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { components: { components: { custom_id: string; label: string }[] }[] },
    ];
    const btn = body.components[0]?.components[0];
    expect(btn?.custom_id).toBe('portal:open');
    expect(btn?.label).toContain('ポータル');

    // Persists under the portal panel keys.
    const settingInserts = captured.filter((c) => /INSERT INTO system_settings/.test(c.sql));
    const keys = settingInserts.map((c) => (c.params as unknown[])[0]);
    expect(keys).toContain('menu.portal.message_id');
    expect(keys).toContain('menu.portal.channel_id');
  });
});
