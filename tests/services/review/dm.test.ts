import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import { sendResultDM } from '../../../src/services/review/dm.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(captured: CapturedCall[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

const AD_ID = 'ad-1';
const SPONSOR_ID = 'sponsor-1';
const CHANNEL_ID = 'dm-chan-1';
const MESSAGE_ID = 'msg-1';

const baseAd = {
  id: AD_ID,
  slot: 'default',
  title: 'My Ad',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendResultDM', () => {
  it('returns no_sponsor and skips REST when sponsorId is null', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(captured);
    const rest = {
      createDmChannel: vi.fn(),
      createMessage: vi.fn(),
    } as unknown as DiscordRest;

    const result = await sendResultDM({
      rest,
      client,
      ad: baseAd,
      sponsorId: null,
      action: 'approved',
    });

    expect(result).toEqual({ ok: false, reason: 'no_sponsor' });
    expect(rest.createDmChannel).not.toHaveBeenCalled();
    expect(rest.createMessage).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('happy approve path: opens DM, sends message, captures UPDATE with status=sent + Date', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(captured);
    const rest = {
      createDmChannel: vi.fn(async () => ({ id: CHANNEL_ID, type: 1 })),
      createMessage: vi.fn(async () => ({ id: MESSAGE_ID, channel_id: CHANNEL_ID })),
    } as unknown as DiscordRest;

    const result = await sendResultDM({
      rest,
      client,
      ad: { ...baseAd, weightSnapshot: 7, startsAt: new Date('2025-01-01T00:00:00Z') },
      sponsorId: SPONSOR_ID,
      action: 'approved',
    });

    expect(result).toEqual({ ok: true, channelId: CHANNEL_ID, messageId: MESSAGE_ID });
    expect(rest.createDmChannel).toHaveBeenCalledWith(SPONSOR_ID);
    expect(rest.createMessage).toHaveBeenCalledTimes(1);
    const [calledChannel, body] = (rest.createMessage as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { embeds: Array<{ title: string }> }];
    expect(calledChannel).toBe(CHANNEL_ID);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]?.title).toContain('承認');

    // UPDATE captured with status='sent' and a Date.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/UPDATE ads/);
    expect(captured[0]?.sql).toMatch(/dm_delivery_status/);
    expect(captured[0]?.params?.[0]).toBe('sent');
    expect(captured[0]?.params?.[1]).toBeInstanceOf(Date);
    expect(captured[0]?.params?.[2]).toBe(AD_ID);
  });

  it('happy reject path: uses reject embed with blockquote and sets sent', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(captured);
    const rest = {
      createDmChannel: vi.fn(async () => ({ id: CHANNEL_ID, type: 1 })),
      createMessage: vi.fn(async () => ({ id: MESSAGE_ID, channel_id: CHANNEL_ID })),
    } as unknown as DiscordRest;

    const result = await sendResultDM({
      rest,
      client,
      ad: baseAd,
      sponsorId: SPONSOR_ID,
      action: 'rejected',
      reason: '規約違反です',
    });

    expect(result).toEqual({ ok: true, channelId: CHANNEL_ID, messageId: MESSAGE_ID });
    const [, body] = (rest.createMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }> },
    ];
    expect(body.embeds[0]?.title).toContain('却下');
    const reasonField = body.embeds[0]?.fields.find((f) => f.name === '却下理由');
    expect(reasonField?.value.startsWith('> ')).toBe(true);
    expect(reasonField?.value).toContain('規約違反です');

    expect(captured[0]?.params?.[0]).toBe('sent');
  });

  it('createDmChannel 403: returns blocked and sets status=failed', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(captured);
    const rest = {
      createDmChannel: vi.fn(async () => {
        throw new DiscordRestError(403, 'Cannot send messages to this user');
      }),
      createMessage: vi.fn(),
    } as unknown as DiscordRest;

    const result = await sendResultDM({
      rest,
      client,
      ad: baseAd,
      sponsorId: SPONSOR_ID,
      action: 'approved',
    });

    expect(result).toEqual({ ok: false, reason: 'blocked', status: 403 });
    expect(rest.createMessage).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.params?.[0]).toBe('failed');
    expect(captured[0]?.params?.[1]).toBeNull();
    expect(captured[0]?.params?.[2]).toBe(AD_ID);
  });

  it('createMessage 403: returns blocked and sets status=failed', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(captured);
    const rest = {
      createDmChannel: vi.fn(async () => ({ id: CHANNEL_ID, type: 1 })),
      createMessage: vi.fn(async () => {
        throw new DiscordRestError(403, 'forbidden');
      }),
    } as unknown as DiscordRest;

    const result = await sendResultDM({
      rest,
      client,
      ad: baseAd,
      sponsorId: SPONSOR_ID,
      action: 'rejected',
      reason: '理由テキスト abc',
    });

    expect(result).toEqual({ ok: false, reason: 'blocked', status: 403 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.params?.[0]).toBe('failed');
  });

  it('createDmChannel non-403 error: returns rest_error and skips UPDATE', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(captured);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rest = {
      createDmChannel: vi.fn(async () => {
        throw new DiscordRestError(500, 'server error');
      }),
      createMessage: vi.fn(),
    } as unknown as DiscordRest;

    const result = await sendResultDM({
      rest,
      client,
      ad: baseAd,
      sponsorId: SPONSOR_ID,
      action: 'approved',
    });

    expect(result).toEqual({ ok: false, reason: 'rest_error' });
    expect(captured).toHaveLength(0);
  });

  it('createMessage non-403 error: returns rest_error and skips UPDATE', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(captured);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rest = {
      createDmChannel: vi.fn(async () => ({ id: CHANNEL_ID, type: 1 })),
      createMessage: vi.fn(async () => {
        throw new DiscordRestError(500, 'server error');
      }),
    } as unknown as DiscordRest;

    const result = await sendResultDM({
      rest,
      client,
      ad: baseAd,
      sponsorId: SPONSOR_ID,
      action: 'approved',
    });

    expect(result).toEqual({ ok: false, reason: 'rest_error' });
    expect(captured).toHaveLength(0);
  });
});
