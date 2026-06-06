import type { PgClient } from '../db/client.ts';
import { SystemSettingKey } from '../db/settings.ts';

export type RotateSaltResult = {
  newSaltLength: number;
  hadPrevious: boolean;
};

const SYSTEM_ACTOR = 'system';

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Atomically rotate the daily ip_hash salt.
 *
 * Storage shape (system_settings.value is JSON text):
 *   { "salt": "<new 32-byte hex>", "previous": "<prior salt or null>" }
 *
 * Why `salt`/`previous` rather than `current`/`previous`: `getDailySalt()`
 * (src/utils/salt.ts) reads `value.salt` after JSON.parse, so keeping the
 * field name preserves every existing reader. `previous` gives us the 24h
 * overlap window the spec calls out — overwritten on the next daily rotation.
 *
 * Atomicity comes from the single INSERT ... ON CONFLICT DO UPDATE: the read
 * of the prior salt is server-side via `json_extract(value, '$.salt')`.
 */
export async function rotateDailySalt(
  client: PgClient,
  options: { actorId?: string } = {},
): Promise<RotateSaltResult> {
  const newSalt = randomHex(32);
  const actorId = options.actorId ?? SYSTEM_ACTOR;
  const newValue = JSON.stringify({ salt: newSalt, previous: null });
  const res = await client.query<{ had_previous: number }>(
    `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, (unixepoch() * 1000), ?)
     ON CONFLICT (key) DO UPDATE
        SET value = json_object(
              'salt',     ?,
              'previous', json_extract(system_settings.value, '$.salt')
            ),
            updated_at = (unixepoch() * 1000),
            updated_by = EXCLUDED.updated_by
     RETURNING CASE
       WHEN json_extract(value, '$.previous') IS NOT NULL THEN 1 ELSE 0
     END AS had_previous`,
    [SystemSettingKey.IP_HASH_SALT, newValue, actorId, newSalt],
  );
  return {
    newSaltLength: newSalt.length,
    hadPrevious: (res.rows[0]?.had_previous ?? 0) === 1,
  };
}
