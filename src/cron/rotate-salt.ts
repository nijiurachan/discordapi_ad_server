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
 * Storage shape (system_settings JSONB):
 *   { "salt": "<new 32-byte hex>", "previous": "<prior salt or null>" }
 *
 * Why `salt`/`previous` rather than the Plan's `current`/`previous`:
 * `getDailySalt()` (src/utils/salt.ts) already reads `value.salt`. Keeping the
 * `salt` field name preserves backward-compat with every existing reader, so
 * the rotation can land without a coordinated reader change. `previous` gives
 * us the 24h overlap window the spec calls out — overwritten naturally on
 * the next daily rotation.
 *
 * Atomicity comes from the single INSERT ... ON CONFLICT DO UPDATE (Plan DC2,
 * option 1): no explicit transaction needed because the read of the prior
 * `salt` happens server-side via `system_settings.value->>'salt'`.
 */
export async function rotateDailySalt(
  client: PgClient,
  options: { actorId?: string } = {},
): Promise<RotateSaltResult> {
  const newSalt = randomHex(32);
  const actorId = options.actorId ?? SYSTEM_ACTOR;
  const res = await client.query<{ had_previous: boolean }>(
    `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES ($1, jsonb_build_object('salt', $2::text, 'previous', null), now(), $3)
     ON CONFLICT (key) DO UPDATE
        SET value = jsonb_build_object(
              'salt', $2::text,
              'previous', system_settings.value->>'salt'
            ),
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
     RETURNING (value ? 'previous' AND value->>'previous' IS NOT NULL) AS had_previous`,
    [SystemSettingKey.IP_HASH_SALT, newSalt, actorId],
  );
  return {
    newSaltLength: newSalt.length,
    hadPrevious: res.rows[0]?.had_previous ?? false,
  };
}
