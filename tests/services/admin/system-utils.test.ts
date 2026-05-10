import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import {
  repostAdminMenu,
  rotateSalt,
  runHealthCheck,
} from '../../../src/services/admin/system-utils.ts';

function mockClient(responses: Array<{ rows?: unknown[]; rowCount?: number }>): PgClient {
  let i = 0;
  return {
    query: vi.fn(async () => {
      const r = responses[i++] ?? {};
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('repostAdminMenu', () => {
  it('returns reposted=[] when ADMIN_MENU_CHANNEL_ID is missing', async () => {
    const client = mockClient([{ rows: [] }]); // SELECT channel returns nothing
    const rest = {
      deleteMessage: vi.fn(),
      createMessage: vi.fn(),
    } as unknown as DiscordRest;
    const result = await repostAdminMenu(client, rest, 'admin-1');
    expect(result.reposted).toEqual([]);
    expect(rest.createMessage).not.toHaveBeenCalled();
  });

  it('deletes the old message (best-effort) and posts a new menu', async () => {
    const client = mockClient([
      { rows: [{ value: 'chan-admin' }] }, // ADMIN_MENU_CHANNEL_ID
      { rows: [{ value: 'msg-old' }] }, // ADMIN_MENU_MESSAGE_ID
      { rowCount: 1 }, // setSystemSetting (UPSERT)
      { rowCount: 1 }, // writeAdminLog
    ]);
    const rest = {
      deleteMessage: vi.fn(async () => undefined),
      createMessage: vi.fn(async () => ({ id: 'msg-new', channel_id: 'chan-admin' })),
    } as unknown as DiscordRest;
    const result = await repostAdminMenu(client, rest, 'admin-1');
    expect(result.reposted[0]?.messageId).toBe('msg-new');
    expect(rest.deleteMessage).toHaveBeenCalledWith('chan-admin', 'msg-old');
    expect(rest.createMessage).toHaveBeenCalledTimes(1);
  });
});

describe('rotateSalt', () => {
  it('writes a new 64-char hex salt and logs the rotation', async () => {
    const client = mockClient([{ rowCount: 1 }, { rowCount: 1 }]);
    const result = await rotateSalt(client, 'admin-1');
    expect(result.newSaltLength).toBe(64);
  });
});

describe('runHealthCheck', () => {
  it('reports both probes as ok when each succeeds', async () => {
    const client = mockClient([{ rowCount: 1 }]);
    const s3 = { send: vi.fn(async () => ({})) } as unknown as S3Client;
    const result = await runHealthCheck(client, s3, 'bucket');
    expect(result).toEqual({ db: 'ok', s3: 'ok' });
  });

  it('reports degraded when db query throws', async () => {
    const client = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
      end: vi.fn(),
    } as unknown as PgClient;
    const s3 = { send: vi.fn(async () => ({})) } as unknown as S3Client;
    const result = await runHealthCheck(client, s3, 'bucket');
    expect(result.db).toBe('unavailable');
    expect(result.s3).toBe('ok');
  });

  it('reports degraded when s3 probe throws (db still ok)', async () => {
    const client = mockClient([{ rowCount: 1 }]);
    const s3 = {
      send: vi.fn(async () => {
        throw new Error('s3 down');
      }),
    } as unknown as S3Client;
    const result = await runHealthCheck(client, s3, 'bucket');
    expect(result.db).toBe('ok');
    expect(result.s3).toBe('unavailable');
  });
});
