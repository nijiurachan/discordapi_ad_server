import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import { openOrReusePortalChannel } from '../../../src/services/portal/open.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function clientWith(handler: (sql: string) => { rows: unknown[]; rowCount?: number }): {
  client: PgClient;
  captured: Capture[];
} {
  const captured: Capture[] = [];
  const client: PgClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = handler(sql);
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
  return { client, captured };
}

const ARGS = {
  guildId: 'g-1',
  botId: 'bot-1',
  categoryId: 'cat-1',
  sponsorId: 's-1',
  reviewerRoleId: 'rev',
  adminRoleId: 'adm',
  uuid: () => 'p-1',
};

const portalRow = {
  id: 'p-existing',
  sponsor_id: 's-1',
  channel_id: 'c-existing',
  dashboard_message_id: 'm-1',
  created_at: new Date(),
  last_active_at: new Date(),
  archived_at: null,
};

describe('openOrReusePortalChannel — reuse', () => {
  it('reuses an active row whose channel still exists', async () => {
    const { client } = clientWith((sql) =>
      /SELECT/.test(sql) ? { rows: [portalRow] } : { rows: [] },
    );
    const rest = {
      getChannel: vi.fn(async () => ({ id: 'c-existing', type: 0 })),
      createGuildChannel: vi.fn(),
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reusedExisting).toBe(true);
      expect(res.channelId).toBe('c-existing');
      expect(res.portalId).toBe('p-existing');
    }
    expect(rest.createGuildChannel).not.toHaveBeenCalled();
  });
});

describe('openOrReusePortalChannel — self-heal', () => {
  it('archives the orphan row when getChannel 404s, then creates fresh', async () => {
    const { client, captured } = clientWith((sql) =>
      /SELECT/.test(sql) ? { rows: [portalRow] } : { rows: [], rowCount: 1 },
    );
    const rest = {
      getChannel: vi.fn(async () => {
        throw new DiscordRestError(404, 'Unknown Channel');
      }),
      createGuildChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
      deleteChannel: vi.fn(),
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reusedExisting).toBe(false);
      expect(res.channelId).toBe('c-new');
    }
    // Orphan archived, then a fresh INSERT for the new channel.
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(true);
    expect(captured.some((c) => /INSERT INTO portal_channels/.test(c.sql))).toBe(true);
    expect(rest.createGuildChannel).toHaveBeenCalledTimes(1);
  });
});

describe('openOrReusePortalChannel — create', () => {
  it('INSERTs row first, then creates the channel under category with overwrites', async () => {
    const { client, captured } = clientWith((sql) =>
      /SELECT/.test(sql) ? { rows: [] } : { rows: [], rowCount: 1 },
    );
    const rest = {
      getChannel: vi.fn(),
      createGuildChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.channelId).toBe('c-new');

    const insertIdx = captured.findIndex((c) => /INSERT INTO portal_channels/.test(c.sql));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    // INSERT used a placeholder channel id (the row exists before the channel).
    const insertParams = captured[insertIdx]?.params as unknown[];
    expect(insertParams[0]).toBe('p-1');
    expect(insertParams[1]).toBe('s-1');

    const [guild, body] = (rest.createGuildChannel as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { parent_id: string; permission_overwrites: { id: string }[] },
    ];
    expect(guild).toBe('g-1');
    expect(body.parent_id).toBe('cat-1');
    expect(body.permission_overwrites.map((o) => o.id)).toEqual([
      'g-1',
      's-1',
      'bot-1',
      'rev',
      'adm',
    ]);
    // After createGuildChannel, the row's channel_id is updated to the real id.
    expect(captured.some((c) => /UPDATE portal_channels SET channel_id = \?/.test(c.sql))).toBe(
      true,
    );
  });

  it('deletes the orphan channel BEFORE the row when the channel_id UPDATE fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Track when each side effect happened so we can assert ordering.
    const events: string[] = [];
    const captured: Capture[] = [];
    const client: PgClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (/SELECT/.test(sql)) return { rows: [], rowCount: 0 };
        if (/UPDATE portal_channels SET channel_id/.test(sql)) {
          throw new Error('step-4 update boom');
        }
        if (/DELETE FROM portal_channels WHERE id = \?/.test(sql)) {
          events.push('rowDelete');
        }
        return { rows: [], rowCount: 1 };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
    const deleteChannel = vi.fn(async () => {
      events.push('deleteChannel');
      return { id: 'c-new', type: 0 };
    });
    const rest = {
      getChannel: vi.fn(),
      createGuildChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
      deleteChannel,
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('db_error');
    // The orphan Discord channel is deleted...
    expect(deleteChannel).toHaveBeenCalledWith('c-new');
    // ...and the orphan row is deleted...
    expect(captured.some((c) => /DELETE FROM portal_channels WHERE id = \?/.test(c.sql))).toBe(
      true,
    );
    // ...with the channel delete strictly preceding the row delete.
    expect(events).toEqual(['deleteChannel', 'rowDelete']);
  });

  it('rolls back the row when createGuildChannel fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, captured } = clientWith((sql) =>
      /SELECT/.test(sql) ? { rows: [] } : { rows: [], rowCount: 1 },
    );
    const rest = {
      getChannel: vi.fn(),
      createGuildChannel: vi.fn(async () => {
        throw new DiscordRestError(500, 'boom');
      }),
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(false);
    // The pre-created row was deleted (compensating cleanup), no orphan left.
    expect(captured.some((c) => /DELETE FROM portal_channels WHERE id = \?/.test(c.sql))).toBe(
      true,
    );
  });
});
