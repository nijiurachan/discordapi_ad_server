import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import {
  type ApproveButtonDeps,
  runApproveButton,
} from '../../../src/interactions/buttons/review-approve-button.ts';

// --- helpers --------------------------------------------------------------

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

function mockRest(overrides?: Partial<DiscordRest>): DiscordRest {
  return {
    editMessage: vi.fn(async () => ({ id: 'msg-1', channel_id: 'review-chan' })),
    createDmChannel: vi.fn(async () => ({ id: 'dm-chan-1', type: 1 })),
    createMessage: vi.fn(async () => ({ id: 'dm-msg-1', channel_id: 'dm-chan-1' })),
    createGuildChannel: vi.fn(async () => ({ id: 'fallback-chan-1', type: 0 })),
    deleteChannel: vi.fn(async () => ({ id: 'fallback-chan-1', type: 0 })),
    ...overrides,
  } as unknown as DiscordRest;
}

const FALLBACK_UUID = 'fb-uuid-1';

const REVIEWER_ROLE_ID = 'role-reviewer';
const AD_ID = '11111111-1111-1111-1111-111111111111';

const adRow = {
  id: AD_ID,
  slot: 'default',
  title: 'My Ad',
  body: 'Hello',
  link_url: 'https://example.com/promo',
  sponsor_id: 'sponsor-1',
  review_message_id: 'review-msg-1',
  image_key: `ads/${AD_ID}/orig.png`,
};

const tierRow = { sponsor_id: 'sponsor-1', status: 'pending', weight: 7 };

function buildPayload(overrides?: {
  customId?: string;
  roles?: string[];
  noMember?: boolean;
}): MessageComponentInteractionPayload {
  const payload: MessageComponentInteractionPayload = {
    type: 3,
    id: 'int-1',
    application_id: 'app-1',
    token: 'tok-1',
    guild_id: 'guild-1',
    channel_id: 'review-chan',
    data: {
      custom_id: overrides?.customId ?? `review:approve:${AD_ID}`,
      component_type: 2,
    },
    message: { id: 'review-msg-1', channel_id: 'review-chan' },
  };
  if (!overrides?.noMember) {
    payload.member = {
      user: { id: 'reviewer-1', username: 'reviewer' },
      roles: overrides?.roles ?? [REVIEWER_ROLE_ID],
    };
  }
  return payload;
}

async function invoke(
  payload: MessageComponentInteractionPayload,
  deps: ApproveButtonDeps,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runApproveButton(c, payload, deps));
  return app.request('http://test/', { method: 'POST' });
}

function defaultDeps(client: PgClient, rest = mockRest()): ApproveButtonDeps {
  return {
    rest,
    client,
    reviewChannelId: 'review-chan',
    s3PublicBaseUrl: 'https://s3.example',
    reviewerRoleId: REVIEWER_ROLE_ID,
    guildId: 'guild-1',
    botId: 'bot-1',
    fallbackCategoryId: 'cat-fallback',
    uuid: () => FALLBACK_UUID,
  };
}

// --- tests ----------------------------------------------------------------

describe('runApproveButton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: snapshot + tier lookup + UPDATE w/ weight_snapshot + log + embed edit + DM', async () => {
    const captured: CapturedCall[] = [];
    // Query order (tx-free atomic approve flow):
    //   1) SELECT ad snapshot (handler)
    //   2) SELECT ad+tier weight (service lookup)
    //   3) atomic approve UPDATE — rowCount: 1
    //   4) getSponsorActiveRegularAllocs SELECT
    //   5) applyEffectiveWeights UPDATE (writes weight_snapshot)
    //   6) SELECT starts_at
    //   7) INSERT review_logs
    //   8) UPDATE ads SET dm_delivery_status='sent' (P3.4)
    const persistedStartsAt = new Date('2026-05-09T12:34:56.000Z');
    const client = mockClient(
      [
        { rows: [adRow] }, // snapshot
        { rows: [{ ...tierRow, weight_alloc: 7 }] }, // lookup
        { rows: [], rowCount: 1 }, // atomic approve UPDATE
        { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
        { rows: [] }, // applyEffectiveWeights UPDATE
        { rows: [{ starts_at: persistedStartsAt }] }, // SELECT starts_at
        { rows: [] }, // INSERT review_logs
        { rows: [], rowCount: 1 }, // dm_delivery_status='sent'
      ],
      captured,
    );
    const rest = mockRest();
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type: number;
      data: { embeds: Array<{ title?: string }>; components: unknown[] };
    };
    // The source review message is edited via the interaction RESPONSE
    // (UPDATE_MESSAGE / type 7): components cleared + outcome embed shown.
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.embeds).toHaveLength(1);
    // The outcome embed reflects an approval (✅ 承認済 by the reviewer).
    expect(json.data.embeds[0]?.title).toContain('承認済');
    expect(json.data.embeds[0]?.title).toContain('reviewer-1');

    // Snapshot SELECT — non-JOIN form on ads, includes review_message_id column.
    const snapshotQ = captured.find(
      (c) =>
        /FROM ads\b/.test(c.sql) && !/FROM ads a/.test(c.sql) && /review_message_id/.test(c.sql),
    );
    expect(snapshotQ).toBeDefined();
    expect(snapshotQ?.params).toEqual([AD_ID]);

    // Service JOIN lookup — uses `ads a` alias and tiers join.
    const lookupQ = captured.find((c) => /FROM ads a/.test(c.sql));
    expect(lookupQ).toBeDefined();
    expect(lookupQ?.sql).toMatch(/JOIN tiers t/);

    // Atomic approve UPDATE — pending guard, approved target, epoch-ms starts_at.
    const update = captured.find((c) => /SET status = 'approved'/.test(c.sql));
    expect(update).toBeDefined();
    expect(update?.sql).toMatch(/starts_at = \(unixepoch/);
    expect(update?.sql).not.toMatch(/now\(\)/);
    expect(update?.sql).toMatch(/status = 'pending'/);
    expect(update?.params).toContain(AD_ID);
    expect(update?.params).toContain('reviewer-1');

    // weight_snapshot is written by the separate applyEffectiveWeights UPDATE.
    const weightWrite = captured.find((c) => /UPDATE ads SET weight_snapshot = \?/.test(c.sql));
    expect(weightWrite).toBeDefined();
    expect(weightWrite?.params).toEqual([7, AD_ID]);

    // review_logs INSERT with action='approved' and reason=null.
    const logInsert = captured.find((c) => /INSERT INTO review_logs/.test(c.sql));
    expect(logInsert).toBeDefined();
    expect(logInsert?.params).toEqual([AD_ID, 'reviewer-1', 'approved', null]);

    // The source message edit is now done by the type-7 interaction response,
    // NOT by a deferred editMessage REST call — so editMessage must not run.
    expect(rest.editMessage).not.toHaveBeenCalled();

    // DM sent: createDmChannel + createMessage with approve embed.
    expect(rest.createDmChannel).toHaveBeenCalledWith('sponsor-1');
    expect(rest.createMessage).toHaveBeenCalledTimes(1);

    // dm_delivery_status UPDATE captured with status='sent' and a Date.
    const dmUpdate = captured.find((c) => /dm_delivery_status/.test(c.sql));
    expect(dmUpdate).toBeDefined();
    expect(dmUpdate?.params?.[0]).toBe('sent');
    expect(dmUpdate?.params?.[1]).toBeInstanceOf(Date);
    expect(dmUpdate?.params?.[2]).toBe(AD_ID);
  });

  it('blocked DM (403 from createDmChannel): triggers fallback, ephemeral notes private channel post', async () => {
    const captured: CapturedCall[] = [];
    // Query order (tx-free atomic approve flow):
    //   1) SELECT ad snapshot
    //   2) SELECT tier (lookup)
    //   3) atomic approve UPDATE
    //   4) getSponsorActiveRegularAllocs SELECT
    //   5) applyEffectiveWeights UPDATE
    //   6) SELECT starts_at
    //   7) INSERT review_logs
    //   8) UPDATE ads SET dm_delivery_status='failed' (DM blocked)
    //   9) SELECT findActiveFallback — empty
    //  10) INSERT dm_fallback_channels
    //  11) UPDATE ads SET dm_delivery_status='fallback_posted'
    const persistedStartsAt = new Date('2026-05-09T12:34:56.000Z');
    const client = mockClient(
      [
        { rows: [adRow] }, // snapshot
        { rows: [{ ...tierRow, weight_alloc: 7 }] }, // lookup
        { rows: [], rowCount: 1 }, // atomic approve UPDATE
        { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
        { rows: [] }, // applyEffectiveWeights UPDATE
        { rows: [{ starts_at: persistedStartsAt }] }, // SELECT starts_at
        { rows: [] }, // INSERT review_logs
        { rows: [], rowCount: 1 }, // dm_delivery_status='failed'
        { rows: [] }, // findActiveFallback — empty
        { rows: [], rowCount: 1 }, // INSERT dm_fallback_channels
        { rows: [], rowCount: 1 }, // dm_delivery_status='fallback_posted'
      ],
      captured,
    );
    const rest = mockRest({
      createDmChannel: vi.fn(async () => {
        throw new DiscordRestError(403, 'Cannot send messages to this user');
      }),
    });
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as {
      type: number;
      data: { embeds: Array<{ title?: string }>; components: unknown[] };
    };
    // Approve still succeeds: type-7 response clears buttons + shows the
    // approved outcome embed. DM + fallback run in the deferred phase, verified
    // by the side effects below.
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.embeds[0]?.title).toContain('承認済');

    // DM was attempted but createMessage on the DM channel never happened — instead
    // createGuildChannel + createMessage on the new private channel did.
    expect(rest.createGuildChannel).toHaveBeenCalledTimes(1);
    expect(rest.createMessage).toHaveBeenCalledTimes(1);

    // Check the dm status transitions: first 'failed' (DM 403), then 'fallback_posted'.
    const dmUpdates = captured.filter((c) => /dm_delivery_status/.test(c.sql));
    expect(dmUpdates).toHaveLength(2);
    expect(dmUpdates[0]?.params?.[0]).toBe('failed');
    expect(dmUpdates[1]?.params?.[0]).toBe('fallback_posted');

    // Fallback row INSERTed.
    const fbInsert = captured.find((c) => /INSERT INTO dm_fallback_channels/.test(c.sql));
    expect(fbInsert).toBeDefined();
    expect(fbInsert?.params?.[0]).toBe(FALLBACK_UUID);
    expect(fbInsert?.params?.[1]).toBe(AD_ID);
    expect(fbInsert?.params?.[2]).toBe('sponsor-1');
  });

  it('blocked DM + createGuildChannel fails: ephemeral notes failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: CapturedCall[] = [];
    // Query order (tx-free atomic approve flow): snapshot, lookup tier, atomic
    // approve UPDATE, getSponsorActiveRegularAllocs, applyEffectiveWeights UPDATE,
    // SELECT starts_at, INSERT log, dm UPDATE (failed), SELECT findActiveFallback (empty)
    const persistedStartsAt = new Date('2026-05-09T12:34:56.000Z');
    const client = mockClient(
      [
        { rows: [adRow] }, // snapshot
        { rows: [{ ...tierRow, weight_alloc: 7 }] }, // lookup
        { rows: [], rowCount: 1 }, // atomic approve UPDATE
        { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
        { rows: [] }, // applyEffectiveWeights UPDATE
        { rows: [{ starts_at: persistedStartsAt }] }, // SELECT starts_at
        { rows: [] }, // INSERT review_logs
        { rows: [], rowCount: 1 }, // dm_delivery_status='failed'
        { rows: [] }, // findActiveFallback — empty
      ],
      captured,
    );
    const rest = mockRest({
      createDmChannel: vi.fn(async () => {
        throw new DiscordRestError(403, 'blocked');
      }),
      createGuildChannel: vi.fn(async () => {
        throw new DiscordRestError(500, 'cannot create channel');
      }),
    });
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as {
      type: number;
      data: { embeds: Array<{ title?: string }>; components: unknown[] };
    };
    // Approve still succeeds (type-7, buttons cleared, approved embed) even
    // when the deferred DM + fallback both fail (console.error'd below).
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.embeds[0]?.title).toContain('承認済');
    // No fallback INSERT, only the original dm 'failed' UPDATE.
    expect(captured.find((c) => /INSERT INTO dm_fallback_channels/.test(c.sql))).toBeUndefined();
    const dmUpdates = captured.filter((c) => /dm_delivery_status/.test(c.sql));
    expect(dmUpdates).toHaveLength(1);
    expect(dmUpdates[0]?.params?.[0]).toBe('failed');
  });

  it('returns ephemeral permission error when member lacks reviewer role', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await invoke(buildPayload({ roles: ['some-other-role'] }), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('レビュアー権限');
    expect(captured).toHaveLength(0);
  });

  it('returns ephemeral when custom_id has no adId segment', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await invoke(buildPayload({ customId: 'review:approve:' }), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('広告 ID');
    expect(captured).toHaveLength(0);
  });

  it('returns ephemeral when ad snapshot lookup finds no row', async () => {
    const client = mockClient([{ rows: [] }]);
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('対象の広告が見つかりません');
  });

  it('returns ephemeral when sponsor has no tier (no_tier)', async () => {
    const client = mockClient([
      { rows: [adRow] }, // snapshot
      { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: null, weight_alloc: 1 }] }, // lookup
    ]);
    const rest = mockRest();
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('ティアロール');
    expect(rest.editMessage).not.toHaveBeenCalled();
  });

  it('returns ephemeral when sponsor_id is null on the ad (no_sponsor)', async () => {
    const client = mockClient([
      { rows: [{ ...adRow, sponsor_id: null }] }, // snapshot
      { rows: [{ sponsor_id: null, status: 'pending', weight: 7, weight_alloc: 1 }] }, // lookup
    ]);
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('スポンサー');
  });

  it('returns ephemeral when the atomic approve UPDATE finds no pending row (race)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [adRow] }, // snapshot
        { rows: [{ ...tierRow, weight_alloc: 1 }] }, // lookup
        { rows: [], rowCount: 0 }, // conditional UPDATE — already moved
        { rows: [{ status: 'approved' }] }, // disambiguation probe
      ],
      captured,
    );
    const rest = mockRest();
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('既に処理');
    // No log insert and no embed edit on race.
    expect(captured.every((c) => !/INSERT INTO review_logs/.test(c.sql))).toBe(true);
    expect(rest.editMessage).not.toHaveBeenCalled();
  });

  it('does not use a deferred editMessage to clear buttons (type-7 owns the edit)', async () => {
    // The source-message edit moved to the interaction RESPONSE (type 7); the
    // deferred path no longer calls editMessage at all. Even if a stray
    // editMessage were to throw, the approve must still succeed via type 7.
    const persistedStartsAt = new Date('2026-05-09T12:34:56.000Z');
    const client = mockClient([
      { rows: [adRow] }, // snapshot
      { rows: [{ ...tierRow, weight_alloc: 7 }] }, // lookup
      { rows: [], rowCount: 1 }, // atomic approve UPDATE
      { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
      { rows: [] }, // applyEffectiveWeights UPDATE
      { rows: [{ starts_at: persistedStartsAt }] }, // SELECT starts_at
      { rows: [] }, // INSERT review_logs
    ]);
    const rest = mockRest({
      editMessage: vi.fn(async () => {
        throw new Error('discord 500');
      }),
    });
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as {
      type: number;
      data: { embeds: Array<{ title?: string }>; components: unknown[] };
    };
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.embeds[0]?.title).toContain('承認済');
    // No deferred editMessage REST call is made anymore.
    expect(rest.editMessage).not.toHaveBeenCalled();
  });

  it('clears buttons via type 7 even when review_message_id is missing', async () => {
    // The interaction targets the clicked message directly, so the type-7
    // response clears its buttons regardless of the stored review_message_id;
    // no separate editMessage REST hop is needed.
    const persistedStartsAt = new Date('2026-05-09T12:34:56.000Z');
    const client = mockClient([
      { rows: [{ ...adRow, review_message_id: null }] }, // snapshot
      { rows: [{ ...tierRow, weight_alloc: 7 }] }, // lookup
      { rows: [], rowCount: 1 }, // atomic approve UPDATE
      { rows: [{ id: AD_ID, weight_alloc: 7 }] }, // getSponsorActiveRegularAllocs
      { rows: [] }, // applyEffectiveWeights UPDATE
      { rows: [{ starts_at: persistedStartsAt }] }, // SELECT starts_at
      { rows: [] }, // INSERT review_logs
    ]);
    const rest = mockRest();
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as {
      type: number;
      data: { embeds: Array<{ title?: string }>; components: unknown[] };
    };
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.embeds[0]?.title).toContain('承認済');
    expect(rest.editMessage).not.toHaveBeenCalled();
  });
});
