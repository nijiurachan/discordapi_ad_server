import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import {
  SystemSettingKey,
  deleteSystemSetting,
  getSystemSetting,
  setSystemSetting,
} from '../../src/db/settings.ts';

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

describe('SystemSettingKey', () => {
  it('exposes the expected menu key constants', () => {
    expect(SystemSettingKey.SUBMIT_MENU_MESSAGE_ID).toBe('menu.submit.message_id');
    expect(SystemSettingKey.SUBMIT_MENU_CHANNEL_ID).toBe('menu.submit.channel_id');
    expect(SystemSettingKey.REVIEW_MENU_MESSAGE_ID).toBe('menu.review.message_id');
    expect(SystemSettingKey.REVIEW_MENU_CHANNEL_ID).toBe('menu.review.channel_id');
    expect(SystemSettingKey.ADMIN_MENU_MESSAGE_ID).toBe('menu.admin.message_id');
    expect(SystemSettingKey.ADMIN_MENU_CHANNEL_ID).toBe('menu.admin.channel_id');
  });
});

describe('getSystemSetting', () => {
  it('returns null when no row matches', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    const value = await getSystemSetting<string>(client, 'missing.key');
    expect(value).toBeNull();
    expect(captured[0]?.sql).toMatch(/SELECT value FROM system_settings/);
    expect(captured[0]?.params).toEqual(['missing.key']);
  });

  it('returns the stored value when a row exists', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ value: 'msg-123' }] }], captured);
    const value = await getSystemSetting<string>(client, SystemSettingKey.SUBMIT_MENU_MESSAGE_ID);
    expect(value).toBe('msg-123');
    expect(captured[0]?.params).toEqual(['menu.submit.message_id']);
  });
});

describe('setSystemSetting', () => {
  it('issues an UPSERT with JSON-encoded value and updatedBy', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    await setSystemSetting(client, SystemSettingKey.SUBMIT_MENU_MESSAGE_ID, 'msg-1', 'actor-1');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/INSERT INTO system_settings/);
    expect(captured[0]?.sql).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(captured[0]?.params).toEqual([
      'menu.submit.message_id',
      JSON.stringify('msg-1'),
      'actor-1',
    ]);
  });

  it('passes null updatedBy through', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    await setSystemSetting(client, 'k', { foo: 'bar' }, null);
    expect(captured[0]?.params).toEqual(['k', JSON.stringify({ foo: 'bar' }), null]);
  });
});

describe('deleteSystemSetting', () => {
  it('issues a DELETE for the given key', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    await deleteSystemSetting(client, SystemSettingKey.SUBMIT_MENU_MESSAGE_ID);
    expect(captured[0]?.sql).toMatch(/DELETE FROM system_settings/);
    expect(captured[0]?.params).toEqual(['menu.submit.message_id']);
  });
});
