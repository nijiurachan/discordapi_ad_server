import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { deleteTier, listTiers, upsertTier } from '../../../src/db/queries/tiers.ts';

function mockClient(
  responses: Array<{ rows?: unknown[]; rowCount?: number; throw?: unknown }>,
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async () => {
      const r = responses[i++] ?? {};
      if (r.throw) throw r.throw;
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('listTiers', () => {
  it('orders by rank ascending and maps to camelCase', async () => {
    const client = mockClient([
      {
        rows: [
          {
            id: 1,
            discord_role_id: 'r1',
            name: 'Bronze',
            weight: 10,
            max_active_ads: 1,
            rank: 10,
          },
        ],
      },
    ]);
    const tiers = await listTiers(client);
    expect(tiers[0]).toEqual({
      id: 1,
      discordRoleId: 'r1',
      name: 'Bronze',
      weight: 10,
      maxActiveAds: 1,
      rank: 10,
    });
  });
});

describe('upsertTier', () => {
  it('returns ok=true on successful UPSERT', async () => {
    const client = mockClient([{ rowCount: 1 }]);
    const result = await upsertTier(client, {
      discordRoleId: 'r1',
      name: 'Bronze',
      weight: 10,
      maxActiveAds: 1,
      rank: 10,
    });
    expect(result.ok).toBe(true);
  });

  it('translates rank uniqueness violation to duplicate_rank', async () => {
    const client = mockClient([{ throw: { code: '23505', constraint: 'tiers_rank_unique' } }]);
    const result = await upsertTier(client, {
      discordRoleId: 'r1',
      name: 'X',
      weight: 1,
      maxActiveAds: 1,
      rank: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('duplicate_rank');
  });

  it('translates other 23505 to duplicate_role', async () => {
    const client = mockClient([{ throw: { code: '23505', constraint: 'some_other_constraint' } }]);
    const result = await upsertTier(client, {
      discordRoleId: 'r1',
      name: 'X',
      weight: 1,
      maxActiveAds: 1,
      rank: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('duplicate_role');
  });
});

describe('deleteTier', () => {
  it('refuses to delete when sponsors reference the tier', async () => {
    const client = mockClient([{ rows: [{ count: '3' }] }]);
    const result = await deleteTier(client, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('sponsor_referenced');
  });

  it('deletes when no references exist', async () => {
    const client = mockClient([{ rows: [{ count: '0' }] }, { rowCount: 1 }]);
    const result = await deleteTier(client, 1);
    expect(result.ok).toBe(true);
  });
});
