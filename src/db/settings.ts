import type { PgClient } from './client.ts';

export const SystemSettingKey = {
  SUBMIT_MENU_MESSAGE_ID: 'menu.submit.message_id',
  SUBMIT_MENU_CHANNEL_ID: 'menu.submit.channel_id',
  REVIEW_MENU_MESSAGE_ID: 'menu.review.message_id',
  REVIEW_MENU_CHANNEL_ID: 'menu.review.channel_id',
  ADMIN_MENU_MESSAGE_ID: 'menu.admin.message_id',
  ADMIN_MENU_CHANNEL_ID: 'menu.admin.channel_id',
  IP_HASH_SALT: 'ip_hash_salt',
} as const;

export async function getSystemSetting<T = unknown>(
  client: PgClient,
  key: string,
): Promise<T | null> {
  // `value` is JSON text in D1/SQLite (was jsonb in Postgres). Parse on read
  // so callers see the same `{ ... }` / primitive shape as before. Strings
  // that aren't valid JSON return null defensively.
  const res = await client.query<{ value: string | null }>(
    'SELECT value FROM system_settings WHERE key = ? LIMIT 1',
    [key],
  );
  const raw = res.rows[0]?.value;
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setSystemSetting<T>(
  client: PgClient,
  key: string,
  value: T,
  updatedBy: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, (unixepoch() * 1000), ?)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = (unixepoch() * 1000),
           updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), updatedBy],
  );
}

export async function deleteSystemSetting(client: PgClient, key: string): Promise<void> {
  await client.query('DELETE FROM system_settings WHERE key = ?', [key]);
}
