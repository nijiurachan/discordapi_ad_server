import type { PgClient } from './client.ts';

export const SystemSettingKey = {
  SUBMIT_MENU_MESSAGE_ID: 'menu.submit.message_id',
  SUBMIT_MENU_CHANNEL_ID: 'menu.submit.channel_id',
  REVIEW_MENU_MESSAGE_ID: 'menu.review.message_id',
  REVIEW_MENU_CHANNEL_ID: 'menu.review.channel_id',
  ADMIN_MENU_MESSAGE_ID: 'menu.admin.message_id',
  ADMIN_MENU_CHANNEL_ID: 'menu.admin.channel_id',
} as const;

export async function getSystemSetting<T = unknown>(
  client: PgClient,
  key: string,
): Promise<T | null> {
  const res = await client.query<{ value: T }>(
    'SELECT value FROM system_settings WHERE key = $1 LIMIT 1',
    [key],
  );
  return res.rows[0]?.value ?? null;
}

export async function setSystemSetting<T>(
  client: PgClient,
  key: string,
  value: T,
  updatedBy: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), updatedBy],
  );
}

export async function deleteSystemSetting(client: PgClient, key: string): Promise<void> {
  await client.query('DELETE FROM system_settings WHERE key = $1', [key]);
}
