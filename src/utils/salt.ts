import type { PgClient } from '../db/client.ts';
import { getSystemSetting } from '../db/settings.ts';

const SALT_KEY = 'ip_hash_salt';

type SaltValue = { salt: string };

/**
 * Read the current daily salt from system_settings. The value is stored
 * as JSONB { "salt": "..." } so it can grow with metadata in P7 (e.g., previous
 * salt for grace-period dedup).
 *
 * If no row exists yet (initial deploy), returns the bootstrap fallback.
 * Caller is expected to treat any thrown DB error as a fatal failure.
 */
export async function getDailySalt(client: PgClient, fallback: string): Promise<string> {
  const value = await getSystemSetting<SaltValue>(client, SALT_KEY);
  if (!value) return fallback;
  if (typeof value.salt !== 'string' || value.salt.trim().length === 0) {
    // corrupted / unexpected shape (missing or whitespace-only) — fall back to
    // bootstrap rather than crashing. The original (untrimmed) value is
    // preserved for hashing so the input matches what was stored.
    return fallback;
  }
  return value.salt;
}
