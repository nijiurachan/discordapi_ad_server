import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import { closePortal } from '../../../src/services/portal/teardown.ts';

const row = {
  id: 'p-1',
  sponsor_id: 's-1',
  channel_id: 'c-1',
  dashboard_message_id: null,
  created_at: new Date(),
  last_active_at: new Date(),
  archived_at: null,
};

function client(rows: unknown[], captured: { sql: string; params: unknown[] | undefined }[] = []) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  } as PgClient;
}

describe('closePortal', () => {
  it('rejects a non-owner', async () => {
    const rest = { deleteChannel: vi.fn() } as unknown as DiscordRest;
    const res = await closePortal({
      client: client([row]),
      rest,
      portalId: 'p-1',
      userId: 'someone-else',
    });
    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    expect(rest.deleteChannel).not.toHaveBeenCalled();
  });

  it('returns not_found when missing', async () => {
    const rest = { deleteChannel: vi.fn() } as unknown as DiscordRest;
    const res = await closePortal({ client: client([]), rest, portalId: 'p-1', userId: 's-1' });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('archives the row and deletes the channel for the owner', async () => {
    const captured: { sql: string; params: unknown[] | undefined }[] = [];
    const rest = {
      deleteChannel: vi.fn(async () => ({ id: 'c-1', type: 0 })),
    } as unknown as DiscordRest;
    const res = await closePortal({
      client: client([row], captured),
      rest,
      portalId: 'p-1',
      userId: 's-1',
    });
    expect(res).toEqual({ ok: true });
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(true);
    expect(rest.deleteChannel).toHaveBeenCalledWith('c-1');
  });

  it('tolerates a 404 on deleteChannel (already gone)', async () => {
    const rest = {
      deleteChannel: vi.fn(async () => {
        throw new DiscordRestError(404, 'Unknown Channel');
      }),
    } as unknown as DiscordRest;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await closePortal({ client: client([row]), rest, portalId: 'p-1', userId: 's-1' });
    expect(res).toEqual({ ok: true });
  });
});
