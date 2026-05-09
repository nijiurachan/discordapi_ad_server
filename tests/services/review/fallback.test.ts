import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import { createOrReuseFallbackChannel } from '../../../src/services/review/fallback.ts';

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

const AD_ID = '11111111-2222-3333-4444-555555555555';
const SPONSOR_ID = 'sponsor-1';
const GUILD_ID = 'guild-1';
const BOT_ID = 'bot-1';
const CATEGORY_ID = 'cat-1';
const FALLBACK_ID = 'fb-uuid-1';
const NEW_CHAN_ID = 'new-chan-1';
const NEW_MSG_ID = 'new-msg-1';
const EXISTING_CHAN_ID = 'existing-chan-1';
const EXISTING_FB_ID = 'existing-fb-id';

const baseAd = {
  id: AD_ID,
  slot: 'default',
  title: 'My Ad',
};

const existingDbRow = {
  id: EXISTING_FB_ID,
  ad_id: AD_ID,
  sponsor_id: SPONSOR_ID,
  channel_id: EXISTING_CHAN_ID,
  created_at: new Date('2026-05-01T00:00:00Z'),
  expires_at: new Date('2026-05-15T00:00:00Z'),
  acknowledged_at: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function defaultArgs(overrides?: {
  client?: PgClient;
  rest?: DiscordRest;
  action?: 'approved' | 'rejected';
  reason?: string;
}): Parameters<typeof createOrReuseFallbackChannel>[0] {
  const client = overrides?.client ?? mockClient([{ rows: [] }, { rows: [] }, { rows: [] }]);
  const rest =
    overrides?.rest ??
    ({
      createGuildChannel: vi.fn(async () => ({ id: NEW_CHAN_ID, type: 0 })),
      createMessage: vi.fn(async () => ({ id: NEW_MSG_ID, channel_id: NEW_CHAN_ID })),
    } as unknown as DiscordRest);
  const args: Parameters<typeof createOrReuseFallbackChannel>[0] = {
    rest,
    client,
    guildId: GUILD_ID,
    botId: BOT_ID,
    categoryId: CATEGORY_ID,
    ad: baseAd,
    sponsorId: SPONSOR_ID,
    action: overrides?.action ?? 'approved',
    uuid: () => FALLBACK_ID,
  };
  if (overrides?.reason !== undefined) {
    args.reason = overrides.reason;
  }
  return args;
}

describe('createOrReuseFallbackChannel — happy path (no existing row)', () => {
  it('creates channel with correct name + overwrites, INSERTs row, posts message, sets dm_delivery_status=fallback_posted', async () => {
    const captured: CapturedCall[] = [];
    // Query order:
    //   1) findActiveFallback SELECT — empty
    //   2) createFallbackRow INSERT
    //   3) setDmDeliveryStatus UPDATE
    const client = mockClient(
      [{ rows: [] }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }],
      captured,
    );
    const rest = {
      createGuildChannel: vi.fn(async () => ({ id: NEW_CHAN_ID, type: 0 })),
      createMessage: vi.fn(async () => ({ id: NEW_MSG_ID, channel_id: NEW_CHAN_ID })),
    } as unknown as DiscordRest;

    const before = Date.now();
    const result = await createOrReuseFallbackChannel(defaultArgs({ client, rest }));
    const after = Date.now();

    expect(result).toEqual({
      ok: true,
      fallbackId: FALLBACK_ID,
      channelId: NEW_CHAN_ID,
      messageId: NEW_MSG_ID,
      reusedExisting: false,
    });

    // createGuildChannel called with name=result-<8 hex>, type=0, parent_id, overwrites
    expect(rest.createGuildChannel).toHaveBeenCalledTimes(1);
    const [calledGuild, body] = (rest.createGuildChannel as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [
      string,
      {
        name: string;
        type: number;
        parent_id: string;
        permission_overwrites: Array<{
          id: string;
          type: number;
          allow?: string;
          deny?: string;
        }>;
      },
    ];
    expect(calledGuild).toBe(GUILD_ID);
    expect(body.name).toBe(`result-${AD_ID.slice(0, 8)}`);
    expect(body.type).toBe(0);
    expect(body.parent_id).toBe(CATEGORY_ID);
    const overwrites = body.permission_overwrites;
    expect(overwrites).toHaveLength(3);
    expect(overwrites[0]).toEqual({ id: GUILD_ID, type: 0, deny: '1024' });
    expect(overwrites[1]).toEqual({ id: SPONSOR_ID, type: 1, allow: '66560' });
    expect(overwrites[2]).toEqual({ id: BOT_ID, type: 1, allow: '76800' });

    // INSERT into dm_fallback_channels with all 5 columns and expires_at ~7 days
    const insert = captured.find((c) => /INSERT INTO dm_fallback_channels/.test(c.sql));
    expect(insert).toBeDefined();
    const params = insert?.params as unknown[];
    expect(params[0]).toBe(FALLBACK_ID);
    expect(params[1]).toBe(AD_ID);
    expect(params[2]).toBe(SPONSOR_ID);
    expect(params[3]).toBe(NEW_CHAN_ID);
    const expiresAt = params[4] as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + sevenDaysMs + 1000);

    // createMessage called with embed + ack button (style 3, custom_id ack:<fb id>)
    expect(rest.createMessage).toHaveBeenCalledTimes(1);
    const [calledChannel, msgBody] = (rest.createMessage as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [
      string,
      {
        content: string;
        embeds: Array<{ title: string }>;
        components: Array<{
          type: number;
          components: Array<{ style: number; custom_id: string; label: string }>;
        }>;
      },
    ];
    expect(calledChannel).toBe(NEW_CHAN_ID);
    expect(msgBody.content).toContain(SPONSOR_ID);
    expect(msgBody.embeds[0]?.title).toContain('承認');
    expect(msgBody.components[0]?.type).toBe(1);
    const button = msgBody.components[0]?.components[0];
    expect(button?.style).toBe(3);
    expect(button?.custom_id).toBe(`ack:${FALLBACK_ID}`);
    expect(button?.label).toContain('了解');

    // dm_delivery_status='fallback_posted'
    const dmUpdate = captured.find((c) => /dm_delivery_status/.test(c.sql));
    expect(dmUpdate).toBeDefined();
    expect(dmUpdate?.params?.[0]).toBe('fallback_posted');
    expect(dmUpdate?.params?.[2]).toBe(AD_ID);
  });

  it('reject action uses reject embed with reason', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [{ rows: [] }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }],
      captured,
    );
    const rest = {
      createGuildChannel: vi.fn(async () => ({ id: NEW_CHAN_ID, type: 0 })),
      createMessage: vi.fn(async () => ({ id: NEW_MSG_ID, channel_id: NEW_CHAN_ID })),
    } as unknown as DiscordRest;

    await createOrReuseFallbackChannel(
      defaultArgs({ client, rest, action: 'rejected', reason: '規約違反' }),
    );

    const [, msgBody] = (rest.createMessage as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      { embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }> },
    ];
    expect(msgBody.embeds[0]?.title).toContain('却下');
    const reasonField = msgBody.embeds[0]?.fields.find((f) => f.name === '却下理由');
    expect(reasonField?.value).toContain('規約違反');
  });
});

describe('createOrReuseFallbackChannel — reuse existing active fallback', () => {
  it('appends a new message to existing channel, no INSERT, no dm_delivery_status UPDATE', async () => {
    const captured: CapturedCall[] = [];
    // Only the SELECT runs — append goes via REST only.
    const client = mockClient([{ rows: [existingDbRow] }], captured);
    const rest = {
      createGuildChannel: vi.fn(),
      createMessage: vi.fn(async () => ({ id: 'append-msg-1', channel_id: EXISTING_CHAN_ID })),
    } as unknown as DiscordRest;

    const result = await createOrReuseFallbackChannel(defaultArgs({ client, rest }));

    expect(result).toEqual({
      ok: true,
      fallbackId: EXISTING_FB_ID,
      channelId: EXISTING_CHAN_ID,
      messageId: 'append-msg-1',
      reusedExisting: true,
    });

    expect(rest.createGuildChannel).not.toHaveBeenCalled();
    expect(rest.createMessage).toHaveBeenCalledTimes(1);
    const [calledChannel, msgBody] = (rest.createMessage as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [
      string,
      {
        content: string;
        components: Array<{ components: Array<{ custom_id: string }> }>;
      },
    ];
    expect(calledChannel).toBe(EXISTING_CHAN_ID);
    expect(msgBody.content).toContain('追加投稿');
    expect(msgBody.components[0]?.components[0]?.custom_id).toBe(`ack:${EXISTING_FB_ID}`);

    // No INSERT, no dm_delivery_status UPDATE.
    expect(captured.find((c) => /INSERT INTO dm_fallback_channels/.test(c.sql))).toBeUndefined();
    expect(captured.find((c) => /dm_delivery_status/.test(c.sql))).toBeUndefined();
  });

  it('returns rest_error when append createMessage fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [existingDbRow] }], captured);
    const rest = {
      createGuildChannel: vi.fn(),
      createMessage: vi.fn(async () => {
        throw new DiscordRestError(500, 'oops');
      }),
    } as unknown as DiscordRest;

    const result = await createOrReuseFallbackChannel(defaultArgs({ client, rest }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rest_error');
    }
    // No INSERT either.
    expect(captured.find((c) => /INSERT INTO dm_fallback_channels/.test(c.sql))).toBeUndefined();
  });
});

describe('createOrReuseFallbackChannel — failures', () => {
  it('createGuildChannel fails: returns rest_error and skips INSERT/UPDATE', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [] }], captured);
    const rest = {
      createGuildChannel: vi.fn(async () => {
        throw new DiscordRestError(500, 'cannot create channel');
      }),
      createMessage: vi.fn(),
    } as unknown as DiscordRest;

    const result = await createOrReuseFallbackChannel(defaultArgs({ client, rest }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rest_error');
    }
    expect(rest.createMessage).not.toHaveBeenCalled();
    // No INSERT (channel was never created).
    expect(captured.find((c) => /INSERT INTO dm_fallback_channels/.test(c.sql))).toBeUndefined();
    expect(captured.find((c) => /dm_delivery_status/.test(c.sql))).toBeUndefined();
  });

  it('createMessage on new channel fails: marks row acknowledged + deletes channel; returns rest_error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: CapturedCall[] = [];
    // SELECT empty + INSERT row succeeds + UPDATE acknowledged_at (compensating)
    const client = mockClient(
      [{ rows: [] }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }],
      captured,
    );
    const rest = {
      createGuildChannel: vi.fn(async () => ({ id: NEW_CHAN_ID, type: 0 })),
      createMessage: vi.fn(async () => {
        throw new DiscordRestError(500, 'cannot post');
      }),
      deleteChannel: vi.fn(async () => ({ id: NEW_CHAN_ID, type: 0 })),
    } as unknown as DiscordRest;

    const result = await createOrReuseFallbackChannel(defaultArgs({ client, rest }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rest_error');
    }
    // INSERT happened, then a compensating UPDATE acknowledged_at on the same row.
    expect(captured.find((c) => /INSERT INTO dm_fallback_channels/.test(c.sql))).toBeDefined();
    const ackUpdate = captured.find((c) =>
      /UPDATE dm_fallback_channels SET acknowledged_at/.test(c.sql),
    );
    expect(ackUpdate).toBeDefined();
    expect(ackUpdate?.params?.[0]).toBe(FALLBACK_ID);
    // No dm_delivery_status UPDATE because the post failed.
    expect(captured.find((c) => /dm_delivery_status/.test(c.sql))).toBeUndefined();
    // Channel was deleted to clean up the orphan.
    expect(rest.deleteChannel).toHaveBeenCalledTimes(1);
    expect((rest.deleteChannel as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      NEW_CHAN_ID,
    );
  });

  it('createFallbackRow fails: deletes the orphan channel and returns rest_error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: CapturedCall[] = [];
    // SELECT empty + INSERT throws.
    const client: PgClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (/INSERT INTO dm_fallback_channels/.test(sql)) {
          throw new Error('FK violation');
        }
        return { rows: [], rowCount: 0 };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
    const rest = {
      createGuildChannel: vi.fn(async () => ({ id: NEW_CHAN_ID, type: 0 })),
      createMessage: vi.fn(),
      deleteChannel: vi.fn(async () => ({ id: NEW_CHAN_ID, type: 0 })),
    } as unknown as DiscordRest;

    const result = await createOrReuseFallbackChannel(defaultArgs({ client, rest }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rest_error');
    }
    // createMessage never reached.
    expect(rest.createMessage).not.toHaveBeenCalled();
    // Channel was deleted to clean up the orphan.
    expect(rest.deleteChannel).toHaveBeenCalledTimes(1);
    expect((rest.deleteChannel as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      NEW_CHAN_ID,
    );
    // No dm_delivery_status UPDATE.
    expect(captured.find((c) => /dm_delivery_status/.test(c.sql))).toBeUndefined();
  });
});
