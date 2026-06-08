import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type { ModalSubmitInteractionPayload } from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import {
  type PortalWeightModalDeps,
  runPortalWeightModal,
} from '../../../src/interactions/modals/portal-weight-modal.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

// Routes each query to a response based on a SQL matcher, capturing every call.
// `weightUpdateRowCount` controls whether the atomic guarded UPDATE "applied".
function mockClient(opts: {
  captured: CapturedCall[];
  weightUpdateRowCount: number;
  tierWeight?: number | null; // null => sponsor has no tier
  usedAfter?: number; // SUM(weight_alloc) reported by sumActiveWeight
  portalRow?: Record<string, unknown> | null;
  allocs?: Array<{ id: string; weight_alloc: number | null }>;
  banners?: Array<Record<string, unknown>>;
  tiers?: Array<Record<string, unknown>>; // rows returned to refreshSponsorTier
}): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      opts.captured.push({ sql, params });
      // atomic ownership+budget guarded weight UPDATE
      if (/UPDATE ads\s+SET weight_alloc/.test(sql)) {
        return { rows: [], rowCount: opts.weightUpdateRowCount };
      }
      // refreshSponsorTier: all tiers ordered by rank desc
      if (/FROM tiers ORDER BY rank DESC/.test(sql)) {
        return { rows: opts.tiers ?? [] };
      }
      // refreshSponsorTier: sponsor UPSERT
      if (/INSERT INTO sponsors/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      // getSponsorBudget tier lookup
      if (/SELECT t\.weight\s+FROM sponsors s\s+JOIN tiers t/.test(sql)) {
        return opts.tierWeight == null ? { rows: [] } : { rows: [{ weight: opts.tierWeight }] };
      }
      // sumActiveWeight
      if (/COALESCE\(SUM\(weight_alloc\), 0\) AS used/.test(sql)) {
        return { rows: [{ used: opts.usedAfter ?? 0 }] };
      }
      // getSponsorActiveRegularAllocs
      if (/SELECT id, weight_alloc\s+FROM ads/.test(sql)) {
        return { rows: opts.allocs ?? [] };
      }
      // applyEffectiveWeights per-id UPDATEs
      if (/UPDATE ads SET weight_snapshot/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      // findOpenPortalBySponsor
      if (/FROM portal_channels/.test(sql)) {
        return { rows: opts.portalRow === undefined ? [] : opts.portalRow ? [opts.portalRow] : [] };
      }
      // getSponsorActiveBanners (SELECT id, slot, title, status, weight_alloc)
      if (/SELECT id, slot, title, status, weight_alloc/.test(sql)) {
        return { rows: opts.banners ?? [] };
      }
      // touchPortalActivity
      if (/UPDATE portal_channels SET last_active_at/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  } as unknown as PgClient;
}

function mockRest(roles: string[] = []): DiscordRest {
  return {
    editMessage: vi.fn(async () => ({ id: 'm-1', channel_id: 'c-1' })),
    createMessage: vi.fn(async () => ({ id: 'm-2', channel_id: 'c-1' })),
    getGuildMember: vi.fn(async () => ({ roles })),
  } as unknown as DiscordRest;
}

const portalRow = {
  id: 'p-1',
  sponsor_id: 's-1',
  channel_id: 'c-1',
  dashboard_message_id: 'm-1',
  created_at: new Date(),
  last_active_at: new Date(),
  archived_at: null,
};

function payload(weight: string, adId = 'a-9', clicker = 's-1'): ModalSubmitInteractionPayload {
  return {
    type: 5,
    id: 'int-1',
    application_id: 'app-1',
    guild_id: 'g-1',
    channel_id: 'c-1',
    member: { user: { id: clicker, username: 'spon' } },
    data: {
      custom_id: `portal:weight-modal:${adId}`,
      components: [{ type: 1, components: [{ type: 4, custom_id: 'weight', value: weight }] }],
    },
  } as ModalSubmitInteractionPayload;
}

async function invoke(
  p: ModalSubmitInteractionPayload,
  deps: Omit<PortalWeightModalDeps, 'guildId'> & { guildId?: string },
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runPortalWeightModal(c, p, { guildId: 'g-1', ...deps }));
  return app.request('http://test/', { method: 'POST' });
}

describe('runPortalWeightModal — C success (within budget)', () => {
  it('applies the guarded UPDATE, recalcs effectiveWeights, re-renders, and confirms', async () => {
    const captured: CapturedCall[] = [];
    const rest = mockRest();
    const client = mockClient({
      captured,
      weightUpdateRowCount: 1, // change applied
      tierWeight: 10,
      usedAfter: 7,
      portalRow,
      allocs: [
        { id: 'a-9', weight_alloc: 5 },
        { id: 'b-3', weight_alloc: 2 },
      ],
      banners: [
        { id: 'a-9', slot: 'default', title: 'Promo', status: 'approved', weight_alloc: 5 },
      ],
    });
    const res = await invoke(payload('5'), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };

    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('重みを変更しました');
    expect(json.data.content).toContain('残りウェイト');

    // The atomic ownership+budget guarded UPDATE ran with the new weight + the
    // SUM(weight_alloc)<=tier guard, mirroring submit/approve.
    const upd = captured.find((c) => /UPDATE ads\s+SET weight_alloc/.test(c.sql));
    expect(upd).toBeDefined();
    expect(upd?.sql).toMatch(/COALESCE\(SUM\(weight_alloc\), 0\)/);
    expect(upd?.sql).toMatch(/status IN \('pending', 'approved'\)/);
    expect(upd?.sql).toMatch(/sponsor_id = \?/);
    expect(upd?.params).toContain(5);
    expect(upd?.params).toContain('a-9');
    expect(upd?.params).toContain('s-1');

    // effectiveWeights recalc persisted via applyEffectiveWeights (weight_snapshot
    // UPDATE per surviving id) — reuse, not reinvented.
    expect(captured.some((c) => /UPDATE ads SET weight_snapshot/.test(c.sql))).toBe(true);

    // dashboard re-rendered in place + activity touched.
    expect(rest.editMessage).toHaveBeenCalledWith(
      'c-1',
      'm-1',
      expect.objectContaining({
        embeds: expect.anything(),
        components: expect.anything(),
      }),
    );
    expect(captured.some((c) => /UPDATE portal_channels SET last_active_at/.test(c.sql))).toBe(
      true,
    );
  });

  it("re-renders the dashboard with the sponsor's real plan name (not the unassigned fallback)", async () => {
    const captured: CapturedCall[] = [];
    // The clicker holds the role that maps to the 'ゴールド' tier, so
    // refreshSponsorTier resolves a real tier name for the re-render.
    const rest = mockRest(['role-gold']);
    const client = mockClient({
      captured,
      weightUpdateRowCount: 1,
      tierWeight: 10,
      usedAfter: 7,
      portalRow,
      allocs: [{ id: 'a-9', weight_alloc: 5 }],
      banners: [
        { id: 'a-9', slot: 'default', title: 'Promo', status: 'approved', weight_alloc: 5 },
      ],
      tiers: [
        {
          id: 2,
          discordRoleId: 'role-gold',
          name: 'ゴールド',
          weight: 10,
          maxActiveAds: 5,
          rank: 2,
        },
      ],
    });
    await invoke(payload('5'), { rest, client });

    const editCall = (rest.editMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = editCall?.[2] as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const planField = body.embeds[0]?.fields.find((f) => f.name === 'プラン');
    expect(planField?.value).toBe('ゴールド');
    expect(planField?.value).not.toBe('（ティアロール未付与）');
  });
});

describe('runPortalWeightModal — C budget exceeded', () => {
  it('rejects when the guarded UPDATE affects 0 rows: no recalc, no re-render', async () => {
    const captured: CapturedCall[] = [];
    const rest = mockRest();
    const client = mockClient({
      captured,
      weightUpdateRowCount: 0, // over budget => nothing changed
      tierWeight: 10,
      portalRow,
    });
    const res = await invoke(payload('999'), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string } };

    expect(json.type).toBe(4);
    expect(json.data.content).toContain('変更できませんでした');
    // No effectiveWeights recalc, no dashboard edit when the change didn't apply.
    expect(captured.every((c) => !/UPDATE ads SET weight_snapshot/.test(c.sql))).toBe(true);
    expect(captured.every((c) => !/FROM portal_channels/.test(c.sql))).toBe(true);
    expect(rest.editMessage).not.toHaveBeenCalled();
  });
});

describe('runPortalWeightModal — C non-owner submit', () => {
  it('rejects when sponsor_id != clicker (UPDATE guard yields changes=0)', async () => {
    const captured: CapturedCall[] = [];
    const rest = mockRest();
    // The clicker is 'attacker'; the ad belongs to someone else, so the
    // WHERE sponsor_id = clicker guard matches no row → rowCount 0.
    const client = mockClient({
      captured,
      weightUpdateRowCount: 0,
      tierWeight: 10,
      portalRow,
    });
    const res = await invoke(payload('3', 'a-9', 'attacker'), { rest, client });
    const json = (await res.json()) as { type: number; data: { content: string } };

    expect(json.type).toBe(4);
    expect(json.data.content).toContain('変更できませんでした');
    // ownership is enforced inside the UPDATE: the clicker id is the sponsor_id bind.
    const upd = captured.find((c) => /UPDATE ads\s+SET weight_alloc/.test(c.sql));
    expect(upd?.params).toContain('attacker');
    // no data mutation / re-render on a non-owner submit.
    expect(captured.every((c) => !/UPDATE ads SET weight_snapshot/.test(c.sql))).toBe(true);
    expect(rest.editMessage).not.toHaveBeenCalled();
  });
});

describe('runPortalWeightModal — C invalid input', () => {
  const cases: Array<[string, string]> = [
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-2'],
    ['decimal', '1.5'],
    ['empty', '   '],
  ];
  for (const [name, value] of cases) {
    it(`rejects ${name} input before any DB write`, async () => {
      const captured: CapturedCall[] = [];
      const rest = mockRest();
      const client = mockClient({ captured, weightUpdateRowCount: 1, tierWeight: 10, portalRow });
      const res = await invoke(payload(value), { rest, client });
      const json = (await res.json()) as { type: number; data: { content: string } };
      expect(json.type).toBe(4);
      expect(json.data.content).toContain('1 以上の整数');
      // validation short-circuits: no UPDATE attempted at all.
      expect(captured.length).toBe(0);
      expect(rest.editMessage).not.toHaveBeenCalled();
    });
  }
});

describe('runPortalWeightModal — effectiveWeights linkage', () => {
  it('feeds the post-change allocs through getSponsorActiveRegularAllocs → applyEffectiveWeights', async () => {
    const captured: CapturedCall[] = [];
    const rest = mockRest();
    const client = mockClient({
      captured,
      weightUpdateRowCount: 1,
      tierWeight: 10,
      usedAfter: 6,
      portalRow,
      // new alloc for a-9 is 4 (the changed value); sibling b-3 stays 2.
      allocs: [
        { id: 'a-9', weight_alloc: 4 },
        { id: 'b-3', weight_alloc: 2 },
      ],
      banners: [],
    });
    await invoke(payload('4'), { rest, client });

    // getSponsorActiveRegularAllocs was read AFTER the change, and its rows were
    // persisted as weight_snapshot via applyEffectiveWeights (S=6 <= T=10 ⇒ snapshot=alloc).
    const allocsRead = captured.find((c) => /SELECT id, weight_alloc\s+FROM ads/.test(c.sql));
    expect(allocsRead).toBeDefined();
    const snapWrites = captured.filter((c) => /UPDATE ads SET weight_snapshot/.test(c.sql));
    expect(snapWrites.length).toBe(2);
    const snapParams = snapWrites.flatMap((c) => c.params ?? []);
    expect(snapParams).toContain(4); // a-9 snapshot = new alloc
    expect(snapParams).toContain('a-9');
  });
});
