import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import type { ModalSubmitInteractionPayload } from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import {
  type RejectModalDeps,
  runRejectModal,
} from '../../../src/interactions/modals/review-reject-modal.ts';

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
const VALID_REASON = 'この広告は規約違反です。掲載できません。';

const adRow = {
  id: AD_ID,
  slot: 'default',
  title: 'My Ad',
  body: 'Hello',
  link_url: 'https://example.com/promo',
  sponsor_id: 'sponsor-1',
  review_message_id: 'review-msg-1',
  image_key: `ads/${AD_ID}/orig.png`,
  image_mime: 'image/png',
};

function buildPayload(overrides?: {
  customId?: string;
  reason?: string;
  roles?: string[];
  noMember?: boolean;
}): ModalSubmitInteractionPayload {
  const reason = overrides?.reason ?? VALID_REASON;
  const payload: ModalSubmitInteractionPayload = {
    type: 5,
    id: 'int-1',
    application_id: 'app-1',
    guild_id: 'guild-1',
    channel_id: 'review-chan',
    data: {
      custom_id: overrides?.customId ?? `review-reject-modal:${AD_ID}`,
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: 'reason', value: reason }],
        },
      ],
    },
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
  payload: ModalSubmitInteractionPayload,
  deps: RejectModalDeps,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runRejectModal(c, payload, deps));
  return app.request('http://test/', { method: 'POST' });
}

function defaultDeps(client: PgClient, rest = mockRest()): RejectModalDeps {
  return {
    rest,
    client,
    reviewChannelId: 'review-chan',
    workerBaseUrl: 'https://worker.example',
    reviewerRoleId: REVIEWER_ROLE_ID,
    guildId: 'guild-1',
    botId: 'bot-1',
    fallbackCategoryId: 'cat-fallback',
    uuid: () => FALLBACK_UUID,
  };
}

// --- tests ----------------------------------------------------------------

describe('runRejectModal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: status update, log insert, embed edit, DM, ephemeral confirmation', async () => {
    const captured: CapturedCall[] = [];
    // Query order:
    //   1) SELECT ad row (fetchAdForOutcome)
    //   2) BEGIN
    //   3) UPDATE ads (optimistic) — must report rowCount: 1
    //   4) INSERT review_logs
    //   5) COMMIT
    //   6) UPDATE ads SET dm_delivery_status='sent' (P3.4)
    const client = mockClient(
      [
        { rows: [adRow] },
        { rows: [] }, // BEGIN
        { rows: [], rowCount: 1 },
        { rows: [] }, // INSERT review_logs
        { rows: [] }, // COMMIT
        { rows: [], rowCount: 1 },
      ],
      captured,
    );
    const rest = mockRest();
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('却下を確定');
    expect(json.data.content).toContain('DM で起稿者に通知');

    // Optimistic UPDATE was called with `pending` filter and `rejected` target.
    const update = captured.find((c) => /UPDATE ads SET/.test(c.sql));
    expect(update).toBeDefined();
    // params[0]=adId, params[1]=fromStatus 'pending', params[2]=newStatus 'rejected'
    expect(update?.params?.[0]).toBe(AD_ID);
    expect(update?.params?.[1]).toBe('pending');
    expect(update?.params?.[2]).toBe('rejected');
    // reject_reason set, reviewed_by set.
    expect(update?.params).toContain(VALID_REASON);
    expect(update?.params).toContain('reviewer-1');

    // review_logs INSERT with action='rejected'.
    const logInsert = captured.find((c) => /INSERT INTO review_logs/.test(c.sql));
    expect(logInsert).toBeDefined();
    expect(logInsert?.params).toEqual([AD_ID, 'reviewer-1', 'rejected', VALID_REASON]);

    // editMessage called with empty components and one outcome embed.
    expect(rest.editMessage).toHaveBeenCalledTimes(1);
    expect(rest.editMessage).toHaveBeenCalledWith(
      'review-chan',
      'review-msg-1',
      expect.objectContaining({
        embeds: expect.any(Array),
        components: [],
      }),
    );

    // DM sent: createDmChannel + createMessage with reject embed.
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
    // Query order:
    //   1) SELECT ad
    //   2) BEGIN
    //   3) UPDATE ads (reject)
    //   4) INSERT review_logs
    //   5) COMMIT
    //   6) UPDATE ads SET dm_delivery_status='failed' (DM blocked)
    //   7) SELECT findActiveFallback — empty
    //   8) INSERT dm_fallback_channels
    //   9) UPDATE ads SET dm_delivery_status='fallback_posted'
    const client = mockClient(
      [
        { rows: [adRow] },
        { rows: [] }, // BEGIN
        { rows: [], rowCount: 1 },
        { rows: [] }, // INSERT review_logs
        { rows: [] }, // COMMIT
        { rows: [], rowCount: 1 },
        { rows: [] },
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ],
      captured,
    );
    const rest = mockRest({
      createDmChannel: vi.fn(async () => {
        throw new DiscordRestError(403, 'Cannot send messages to this user');
      }),
    });
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('却下を確定');
    expect(json.data.content).toContain('プライベートチャンネルで通知');

    expect(rest.createGuildChannel).toHaveBeenCalledTimes(1);
    expect(rest.createMessage).toHaveBeenCalledTimes(1);

    const dmUpdates = captured.filter((c) => /dm_delivery_status/.test(c.sql));
    expect(dmUpdates).toHaveLength(2);
    expect(dmUpdates[0]?.params?.[0]).toBe('failed');
    expect(dmUpdates[1]?.params?.[0]).toBe('fallback_posted');

    const fbInsert = captured.find((c) => /INSERT INTO dm_fallback_channels/.test(c.sql));
    expect(fbInsert).toBeDefined();
    expect(fbInsert?.params?.[0]).toBe(FALLBACK_UUID);
    expect(fbInsert?.params?.[1]).toBe(AD_ID);
    expect(fbInsert?.params?.[2]).toBe('sponsor-1');
  });

  it('blocked DM + createGuildChannel fails: ephemeral notes failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [adRow] },
        { rows: [] }, // BEGIN
        { rows: [], rowCount: 1 },
        { rows: [] }, // INSERT review_logs
        { rows: [] }, // COMMIT
        { rows: [], rowCount: 1 },
        { rows: [] }, // findActiveFallback empty
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
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('却下を確定');
    expect(json.data.content).toContain('DM 送信時にエラー');
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
    // No DB calls when auth fails.
    expect(captured).toHaveLength(0);
  });

  it('rejects reason shorter than 10 chars', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await invoke(buildPayload({ reason: 'short' }), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('10〜500');
    expect(captured).toHaveLength(0);
  });

  it('rejects reason longer than 500 chars', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const tooLong = 'あ'.repeat(501);
    const res = await invoke(buildPayload({ reason: tooLong }), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('10〜500');
    expect(captured).toHaveLength(0);
  });

  it('returns ephemeral when custom_id has no adId segment', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    const res = await invoke(
      buildPayload({ customId: 'review-reject-modal:' }),
      defaultDeps(client),
    );
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('広告 ID');
    expect(captured).toHaveLength(0);
  });

  it('returns ephemeral when reviewer id cannot be resolved', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([], captured);
    // member is required for role check, so fake a payload that passes auth
    // but loses the user id by routing through the user fallback (also empty).
    const payload = buildPayload();
    if (payload.member) {
      payload.member = { user: { id: '' }, roles: [REVIEWER_ROLE_ID] };
    }
    const res = await invoke(payload, defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('レビュアー情報');
    expect(captured).toHaveLength(0);
  });

  it('returns ephemeral when ad not found', async () => {
    const client = mockClient([{ rows: [] }]); // SELECT returns 0 rows
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('対象の広告が見つかりません');
  });

  it('returns ephemeral when optimistic UPDATE finds no pending row (race)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [adRow] },
        { rows: [] }, // BEGIN
        { rows: [], rowCount: 0 }, // UPDATE — already moved by another reviewer
        { rows: [] }, // ROLLBACK
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

  it('still returns success when embed edit fails (best-effort)', async () => {
    const client = mockClient([
      { rows: [adRow] },
      { rows: [] }, // BEGIN
      { rows: [], rowCount: 1 },
      { rows: [] }, // INSERT review_logs
      { rows: [] }, // COMMIT
      { rows: [], rowCount: 1 },
    ]);
    const rest = mockRest({
      editMessage: vi.fn(async () => {
        throw new Error('discord 500');
      }),
    });
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('却下を確定');
  });

  it('skips embed edit when review_message_id is missing', async () => {
    const client = mockClient([
      { rows: [{ ...adRow, review_message_id: null }] },
      { rows: [] }, // BEGIN
      { rows: [], rowCount: 1 },
      { rows: [] }, // INSERT review_logs
      { rows: [] }, // COMMIT
      { rows: [], rowCount: 1 },
    ]);
    const rest = mockRest();
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('却下を確定');
    expect(rest.editMessage).not.toHaveBeenCalled();
  });
});
