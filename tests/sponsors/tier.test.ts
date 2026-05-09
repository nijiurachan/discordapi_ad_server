import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import type { DiscordRest } from '../../src/discord/rest.ts';
import {
  type Tier,
  checkMaxActiveAds,
  countActiveAds,
  refreshSponsorTier,
} from '../../src/sponsors/tier.ts';

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

function mockRest(roles: string[]): DiscordRest {
  return {
    getGuildMember: vi.fn(async () => ({ user: { id: 'u1', username: 'u' }, roles })),
    // The rest of DiscordRest surface is unused here, but typed via cast.
  } as unknown as DiscordRest;
}

describe('refreshSponsorTier', () => {
  it('picks the highest-rank tier when multiple roles match', async () => {
    const tierRows: Tier[] = [
      {
        id: 3,
        discordRoleId: 'role-gold',
        name: 'Gold',
        weight: 30,
        maxActiveAds: 3,
        rank: 30,
      },
      {
        id: 2,
        discordRoleId: 'role-silver',
        name: 'Silver',
        weight: 20,
        maxActiveAds: 2,
        rank: 20,
      },
      {
        id: 1,
        discordRoleId: 'role-bronze',
        name: 'Bronze',
        weight: 10,
        maxActiveAds: 1,
        rank: 10,
      },
    ];
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: tierRows }, { rows: [] }], captured);
    const rest = mockRest(['role-bronze', 'role-gold', 'role-silver']);

    const tier = await refreshSponsorTier({
      rest,
      client,
      guildId: 'g1',
      userId: 'u1',
      displayName: 'User One',
    });

    expect(tier?.id).toBe(3);
    expect(tier?.name).toBe('Gold');
    // First query is the tiers SELECT, second is the UPSERT
    expect(captured).toHaveLength(2);
    expect(captured[1]?.params).toEqual(['u1', 'User One', 3]);
  });

  it('returns null and UPSERTs with current_tier_id=null when no role matches', async () => {
    const tierRows: Tier[] = [
      {
        id: 1,
        discordRoleId: 'role-bronze',
        name: 'Bronze',
        weight: 10,
        maxActiveAds: 1,
        rank: 10,
      },
    ];
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: tierRows }, { rows: [] }], captured);
    const rest = mockRest(['some-other-role']);

    const tier = await refreshSponsorTier({
      rest,
      client,
      guildId: 'g1',
      userId: 'u2',
      displayName: 'User Two',
    });

    expect(tier).toBeNull();
    expect(captured[1]?.params).toEqual(['u2', 'User Two', null]);
    expect(captured[1]?.sql).toMatch(/INSERT INTO sponsors/);
  });

  it('calls Discord REST with the right URL', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }, { rows: [] }], captured);
    const getGuildMember = vi.fn(async () => ({ user: { id: 'u3' }, roles: [] }));
    const rest = { getGuildMember } as unknown as DiscordRest;

    await refreshSponsorTier({
      rest,
      client,
      guildId: 'guild-123',
      userId: 'user-456',
      displayName: 'User Three',
    });

    expect(getGuildMember).toHaveBeenCalledTimes(1);
    expect(getGuildMember).toHaveBeenCalledWith('guild-123', 'user-456');
  });
});

describe('countActiveAds', () => {
  it('returns the parsed integer', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ count: '7' }] }], captured);
    const n = await countActiveAds(client, 'sponsor-1');
    expect(n).toBe(7);
    expect(captured[0]?.params).toEqual(['sponsor-1']);
    expect(captured[0]?.sql).toMatch(/FROM ads/);
  });

  it('returns 0 when no rows', async () => {
    const client = mockClient([{ rows: [] }]);
    const n = await countActiveAds(client, 'sponsor-2');
    expect(n).toBe(0);
  });
});

describe('checkMaxActiveAds', () => {
  const tier: Tier = {
    id: 1,
    discordRoleId: 'r',
    name: 'Bronze',
    weight: 10,
    maxActiveAds: 2,
    rank: 10,
  };

  it('returns ok when under limit', () => {
    const result = checkMaxActiveAds(tier, 1);
    expect(result.ok).toBe(true);
  });

  it('returns error when at limit', () => {
    const result = checkMaxActiveAds(tier, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Bronze');
      expect(result.message).toContain('2');
    }
  });

  it('returns error when above limit', () => {
    const result = checkMaxActiveAds(tier, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('5');
    }
  });
});
