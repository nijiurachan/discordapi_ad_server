import type { PgClient } from '../client.ts';

export type TierRow = {
  id: number;
  discordRoleId: string;
  name: string;
  weight: number;
  maxActiveAds: number;
  rank: number;
};

export async function listTiers(client: PgClient): Promise<TierRow[]> {
  const res = await client.query<{
    id: number;
    discord_role_id: string;
    name: string;
    weight: number;
    max_active_ads: number;
    rank: number;
  }>('SELECT id, discord_role_id, name, weight, max_active_ads, rank FROM tiers ORDER BY rank ASC');
  return res.rows.map((r) => ({
    id: r.id,
    discordRoleId: r.discord_role_id,
    name: r.name,
    weight: r.weight,
    maxActiveAds: r.max_active_ads,
    rank: r.rank,
  }));
}

export type TierUpsertInput = {
  discordRoleId: string;
  name: string;
  weight: number;
  maxActiveAds: number;
  rank: number;
};

export type TierMutationError =
  | { ok: false; reason: 'duplicate_role' | 'duplicate_rank' | 'sponsor_referenced' }
  | { ok: true };

export async function upsertTier(
  client: PgClient,
  input: TierUpsertInput,
): Promise<TierMutationError> {
  try {
    await client.query(
      `INSERT INTO tiers (discord_role_id, name, weight, max_active_ads, rank)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (discord_role_id) DO UPDATE SET
         name = EXCLUDED.name,
         weight = EXCLUDED.weight,
         max_active_ads = EXCLUDED.max_active_ads,
         rank = EXCLUDED.rank`,
      [input.discordRoleId, input.name, input.weight, input.maxActiveAds, input.rank],
    );
    return { ok: true };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505') {
        if (e.constraint === 'tiers_rank_unique') return { ok: false, reason: 'duplicate_rank' };
        return { ok: false, reason: 'duplicate_role' };
      }
    }
    throw err;
  }
}

export async function deleteTier(client: PgClient, tierId: number): Promise<TierMutationError> {
  const refRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM sponsors WHERE current_tier_id = $1`,
    [tierId],
  );
  if (Number(refRes.rows[0]?.count ?? '0') > 0) {
    return { ok: false, reason: 'sponsor_referenced' };
  }
  await client.query(`DELETE FROM tiers WHERE id = $1`, [tierId]);
  return { ok: true };
}
