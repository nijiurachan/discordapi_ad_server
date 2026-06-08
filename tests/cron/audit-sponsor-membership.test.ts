import { describe, expect, it, vi } from 'vitest';
import { auditSponsorMembership } from '../../src/cron/audit-sponsor-membership.ts';
import type { PgClient } from '../../src/db/client.ts';
import type { DiscordRest } from '../../src/discord/rest.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };
function mockClient(
  responses: Array<{ rows: unknown[]; rowCount?: number }>,
  captured: CapturedCall[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++];
      if (!r) return { rows: [], rowCount: 0 };
      return { rowCount: r.rowCount ?? r.rows.length, ...r };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

// rest that reports the sponsor present with a single tier role.
function restWithRole(roleId: string): DiscordRest {
  return {
    getGuildMember: vi.fn(async () => ({ user: { id: 'sp-1' }, roles: [roleId] })),
    createDmChannel: vi.fn(async () => ({ id: 'dm-1', type: 1 })),
    createMessage: vi.fn(async () => ({ id: 'm-1', channel_id: 'dm-1' })),
  } as unknown as DiscordRest;
}

describe('auditSponsorMembership weight rescale', () => {
  it('rescales proportionally on downgrade and writes weight_snapshot (no pause)', async () => {
    const captured: CapturedCall[] = [];
    // Order: distinct-sponsors SELECT, tiers SELECT, then per-sponsor:
    //   1) `before` SELECT (id, weight_snapshot over pending+approved),
    //   2) getSponsorActiveRegularAllocs, 3) applyEffectiveWeights UPDATE(s),
    //   4) admin_log INSERT.
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sp-1' }] }, // distinct sponsors
        { rows: [{ id: 1, discord_role_id: 'role-low', weight: 50, rank: 10 }] }, // tiers (downgraded T=50)
        {
          rows: [
            { id: 'a', weight_snapshot: 50 },
            { id: 'b', weight_snapshot: 30 },
            { id: 'c', weight_snapshot: 20 },
          ],
        }, // before
        {
          rows: [
            { id: 'a', weight_alloc: 50 },
            { id: 'b', weight_alloc: 30 },
            { id: 'c', weight_alloc: 20 },
          ],
        }, // allocs Σ=100>50
        { rows: [] }, // UPDATE a -> 25
        { rows: [] }, // UPDATE b -> 15
        { rows: [] }, // UPDATE c -> 10
        { rows: [] }, // admin_log INSERT
      ],
      captured,
    );
    const result = await auditSponsorMembership(client, restWithRole('role-low'), 'g1');
    expect(result.sponsorsWeightSynced).toBe(1);
    const updates = captured.filter((cc) => /SET weight_snapshot = \?/.test(cc.sql));
    const sum = updates.reduce((s, u) => s + Number(u.params?.[0] ?? 0), 0);
    expect(sum).toBe(50); // total snapshot == new T
    expect(captured.some((cc) => /INSERT INTO admin_logs/.test(cc.sql))).toBe(true);
    expect(captured.every((cc) => !/SET status = 'paused'/.test(cc.sql))).toBe(true);
  });
});

describe('auditSponsorMembership pause', () => {
  it('pauses smallest-alloc-first when count > new T, DMs the sponsor', async () => {
    const captured: CapturedCall[] = [];
    const rest = restWithRole('role-tiny');
    const client = mockClient(
      [
        { rows: [{ sponsor_id: 'sp-1' }] }, // distinct sponsors
        { rows: [{ id: 1, discord_role_id: 'role-tiny', weight: 2, rank: 10 }] }, // tiers T=2
        {
          rows: [
            { id: 'a', weight_snapshot: 1 },
            { id: 'b', weight_snapshot: 1 },
            { id: 'c', weight_snapshot: 1 },
          ],
        }, // before (status pending/approved)
        {
          rows: [
            { id: 'a', weight_alloc: 1 },
            { id: 'b', weight_alloc: 1 },
            { id: 'c', weight_alloc: 1 },
          ],
        }, // allocs
        { rows: [] }, // UPDATE weight_snapshot survivor 1
        { rows: [] }, // UPDATE weight_snapshot survivor 2
        { rows: [] }, // UPDATE status='paused' for victim
        { rows: [] }, // admin_log INSERT
      ],
      captured,
    );
    const result = await auditSponsorMembership(client, rest, 'g1');
    expect(result.adsPaused).toBe(1);
    const pause = captured.find((cc) => /SET status = 'paused'/.test(cc.sql));
    expect(pause?.params).toEqual(['a']); // smallest alloc, id-tiebreak ascending
    expect(rest.createDmChannel).toHaveBeenCalledWith('sp-1');
    expect(rest.createMessage).toHaveBeenCalledTimes(1);
  });

  it('excludes admin-contributed ads from the audit entirely', async () => {
    const captured: CapturedCall[] = [];
    // distinct-sponsors SELECT already filters created_by_admin IS NULL, so an
    // admin-only sponsor yields zero rows -> no per-sponsor work.
    const client = mockClient(
      [
        { rows: [] }, // distinct sponsors (admin ads excluded by the query)
        { rows: [{ id: 1, discord_role_id: 'role-x', weight: 10, rank: 10 }] }, // tiers
      ],
      captured,
    );
    const result = await auditSponsorMembership(client, restWithRole('role-x'), 'g1');
    expect(result.sponsorsChecked).toBe(0);
    expect(captured.some((cc) => /SET weight_snapshot/.test(cc.sql))).toBe(false);
  });
});
