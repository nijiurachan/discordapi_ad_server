import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../../src/discord/types.ts';
import { runPortalDashboardButton } from '../../../src/interactions/buttons/portal-dashboard-buttons.ts';

const portalRow = {
  id: 'p-1',
  sponsor_id: 's-1',
  channel_id: 'c-1',
  dashboard_message_id: 'm-1',
  created_at: new Date(),
  last_active_at: new Date(),
  archived_at: null,
};

function payload(customId: string): MessageComponentInteractionPayload {
  return {
    type: 3,
    id: 'i-1',
    application_id: 'app-1',
    token: 'tok-1',
    guild_id: 'g-1',
    channel_id: 'c-1',
    member: { user: { id: 's-1', username: 'spon' } },
    data: { custom_id: customId, component_type: 2 },
  } as unknown as MessageComponentInteractionPayload;
}

function deps(handler: (sql: string) => { rows: unknown[]; rowCount?: number }) {
  return {
    rest: {
      createMessage: vi.fn(async () => ({ id: 'm-2', channel_id: 'c-1' })),
      editMessage: vi.fn(async () => ({ id: 'm-1', channel_id: 'c-1' })),
      deleteChannel: vi.fn(async () => ({ id: 'c-1', type: 0 })),
      getGuildMember: vi.fn(async () => ({ user: { id: 's-1' }, roles: [] })),
    } as unknown as DiscordRest,
    client: {
      query: vi.fn(async (sql: string) => {
        const r = handler(sql);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
      }),
      end: vi.fn(),
    } as unknown as PgClient,
    guildId: 'g-1',
  };
}

async function run(customId: string, d: ReturnType<typeof deps>) {
  const app = new Hono();
  app.post('/', (c) => runPortalDashboardButton(c, payload(customId), d));
  return app.request('/', { method: 'POST' });
}

describe('portal:add', () => {
  it('returns an ephemeral pointing to /ad submit', async () => {
    const res = await run(
      'portal:add',
      deps((sql) => ({ rows: /SELECT/.test(sql) ? [portalRow] : [] })),
    );
    const body = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('/ad submit');
  });
});

describe('portal:refresh', () => {
  it('re-renders the dashboard via UPDATE_MESSAGE (type 7)', async () => {
    const res = await run(
      'portal:refresh',
      deps((sql) => ({ rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [portalRow] : [] })),
    );
    const body = (await res.json()) as { type: number; data: { embeds: unknown[] } };
    expect(body.type).toBe(7);
    expect(Array.isArray(body.data.embeds)).toBe(true);
  });

  it('rejects a non-owner (staff) and never loads the clicker data into the owner channel', async () => {
    // Channel c-1 belongs to 'other-owner'; the clicker is 's-1' (e.g. staff who
    // can VIEW the channel). The portal must resolve by channel, see the owner
    // mismatch, and refuse — NOT overwrite the dashboard with the clicker's data.
    const notOwnerRow = { ...portalRow, sponsor_id: 'other-owner' };
    const d = deps((sql) => ({
      rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [notOwnerRow] : [],
    }));
    const res = await run('portal:refresh', d);
    const body = (await res.json()) as { type: number; data: { content: string } };
    // Ephemeral not-owner message, never a type-7 in-place edit.
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('対象のスポンサーのみ');
    // The clicker's banners/budget must never be loaded into the owner's channel:
    // the ONLY query allowed is the channel lookup; no ads/banner SELECT runs.
    const calls = (d.client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(calls.every((sql) => !/FROM ads/.test(sql))).toBe(true);
    expect(calls.every((sql) => !/UPDATE portal_channels SET last_active_at/.test(sql))).toBe(true);
  });
});

describe('portal:manage', () => {
  it('returns an ephemeral management view', async () => {
    const res = await run(
      'portal:manage',
      deps((sql) => ({ rows: /SELECT/.test(sql) ? [portalRow] : [] })),
    );
    const body = (await res.json()) as { type: number; data: { flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
  });

  it('lists the owner banners with id/title/weight', async () => {
    const d = deps((sql) => {
      if (/SELECT id, sponsor_id, channel_id/.test(sql)) return { rows: [portalRow] };
      if (/FROM ads/.test(sql))
        return {
          rows: [
            { id: 'a-9', slot: 'default', title: 'Promo', status: 'approved', weight_alloc: 4 },
          ],
        };
      return { rows: [] };
    });
    const res = await run('portal:manage', d);
    const body = (await res.json()) as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('a-9');
    expect(body.data.content).toContain('Promo');
    expect(body.data.content).toContain('4');
  });

  it('shows the empty-state when the owner has no banners', async () => {
    const d = deps((sql) => ({
      rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [portalRow] : [],
    }));
    const res = await run('portal:manage', d);
    const body = (await res.json()) as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('管理対象のバナーはありません');
  });

  it('rejects a non-owner (staff) and never loads the clicker banners', async () => {
    const notOwnerRow = { ...portalRow, sponsor_id: 'other-owner' };
    const d = deps((sql) => ({
      rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [notOwnerRow] : [],
    }));
    const res = await run('portal:manage', d);
    const body = (await res.json()) as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('対象のスポンサーのみ');
    const calls = (d.client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    // No banner read for the clicker — the leak is closed.
    expect(calls.every((sql) => !/FROM ads/.test(sql))).toBe(true);
  });
});

describe('portal:close', () => {
  it('archives + deletes for the owner and acks', async () => {
    const d = deps((sql) => ({
      rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [portalRow] : [],
    }));
    const res = await run('portal:close', d);
    const body = (await res.json()) as { type: number };
    // type 4 (ephemeral confirmation) is acceptable since the channel is gone.
    expect([4, 7]).toContain(body.type);
    expect(d.rest.deleteChannel).toHaveBeenCalledWith('c-1');
  });

  it('rejects a non-owner', async () => {
    const notOwner = {
      ...portalRow,
      sponsor_id: 'other',
    };
    const d = deps((sql) => ({
      rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [notOwner] : [],
    }));
    const res = await run('portal:close', d);
    const body = (await res.json()) as { data: { content: string } };
    expect(body.data.content).toContain('スポンサー');
    expect(d.rest.deleteChannel).not.toHaveBeenCalled();
  });
});
