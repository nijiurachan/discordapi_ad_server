import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import type { InsertEventResult } from '../../src/db/queries/ad-events.ts';
import type { Bindings } from '../../src/env.ts';
import { hashIP } from '../../src/utils/ip-hash.ts';

// vi.hoisted is required because vi.mock calls are hoisted above all imports.
// We need the mock fns to be initialized before vi.mock factories run.
const { queryMock, insertEventIfNotRecentMock, getDailySaltMock } = vi.hoisted(() => {
  return {
    queryMock:
      vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>(),
    insertEventIfNotRecentMock:
      vi.fn<
        (
          client: PgClient,
          args: {
            adId: string;
            eventType: 'impression' | 'click';
            ipHash: string | null;
            ua: string | null;
            slot: string | null;
          },
          windowMs?: number,
        ) => Promise<InsertEventResult>
      >(),
    getDailySaltMock: vi.fn<(client: PgClient, fallback: string) => Promise<string>>(),
  };
});

vi.mock('../../src/db/client.ts', () => ({
  withPgClient: vi.fn(async (_url: string, fn: (client: PgClient) => Promise<unknown>) => {
    return fn({
      query: queryMock,
      end: vi.fn(async () => {}),
    } as unknown as PgClient);
  }),
}));

vi.mock('../../src/db/queries/ad-events.ts', () => ({
  insertEventIfNotRecent: insertEventIfNotRecentMock,
}));

vi.mock('../../src/utils/salt.ts', () => ({
  getDailySalt: getDailySaltMock,
}));

import { handleClick } from '../../src/serve/click.ts';

const VALID_AD_ID = '00000000-0000-0000-0000-000000000001';

type MockCtxOpts = {
  adId?: string;
  method?: string;
  headers?: Record<string, string>;
  adRow?: { link_url: string; kind: string } | null;
};

function makeCtx(opts: MockCtxOpts = {}): {
  ctx: Context<{ Bindings: Bindings }>;
  redirectMock: ReturnType<typeof vi.fn>;
  textMock: ReturnType<typeof vi.fn>;
} {
  const adId = opts.adId ?? VALID_AD_ID;
  const method = opts.method ?? 'GET';
  const headers = opts.headers ?? {};

  // First DB call inside handleClick is getAdLinkUrl. We set its row response
  // here. Subsequent calls (insertEventIfNotRecent) are intercepted by the
  // mocks above and never hit queryMock.
  if (opts.adRow === null) {
    queryMock.mockResolvedValueOnce({ rows: [] });
  } else if (opts.adRow !== undefined) {
    queryMock.mockResolvedValueOnce({ rows: [opts.adRow] });
  } else {
    // default: a regular ad
    queryMock.mockResolvedValueOnce({
      rows: [{ link_url: 'https://example.com/landing', kind: 'regular' }],
    });
  }

  const redirectMock = vi.fn(
    (url: string, status: number) => new Response(null, { status, headers: { location: url } }),
  );
  const textMock = vi.fn((msg: string, status: number) => new Response(msg, { status }));

  const ctx = {
    req: {
      param: (k: string) => (k === 'adId' ? adId : undefined),
      header: (name: string) => headers[name.toLowerCase()],
      method,
    },
    env: {
      POSTGRES_URL: 'postgres://test',
      IP_HASH_SALT_BOOTSTRAP: 'bootstrap',
    },
    redirect: redirectMock,
    text: textMock,
  } as unknown as Context<{ Bindings: Bindings }>;

  return { ctx, redirectMock, textMock };
}

describe('handleClick tracking', () => {
  beforeEach(() => {
    queryMock.mockReset();
    insertEventIfNotRecentMock.mockReset();
    insertEventIfNotRecentMock.mockResolvedValue({ ok: true, insertedId: 1n });
    getDailySaltMock.mockReset();
    getDailySaltMock.mockResolvedValue('test-salt');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('400 on invalid ad id (no DB / tracking)', async () => {
    const { ctx, textMock } = makeCtx({ adId: 'not-a-uuid' });
    const res = await handleClick(ctx);
    expect(res.status).toBe(400);
    expect(textMock).toHaveBeenCalledWith('invalid ad id', 400);
    expect(insertEventIfNotRecentMock).not.toHaveBeenCalled();
  });

  it('404 when ad not found (no tracking)', async () => {
    const { ctx, textMock } = makeCtx({ adRow: null });
    const res = await handleClick(ctx);
    expect(res.status).toBe(404);
    expect(textMock).toHaveBeenCalledWith('not found', 404);
    expect(insertEventIfNotRecentMock).not.toHaveBeenCalled();
  });

  it('records click for normal GET on regular ad and 302s (with hashed IP)', async () => {
    const { ctx, redirectMock } = makeCtx({
      headers: { 'user-agent': 'Mozilla/5.0', 'cf-connecting-ip': '1.2.3.4' },
    });
    const res = await handleClick(ctx);
    expect(res.status).toBe(302);
    expect(redirectMock).toHaveBeenCalledWith('https://example.com/landing', 302);

    // Dedup helper invoked exactly once with the click payload.
    expect(getDailySaltMock).toHaveBeenCalled();
    expect(insertEventIfNotRecentMock).toHaveBeenCalledTimes(1);
    expect(insertEventIfNotRecentMock).toHaveBeenCalledWith(
      expect.anything(), // client
      expect.objectContaining({
        adId: VALID_AD_ID,
        eventType: 'click',
        ua: 'Mozilla/5.0',
        slot: null,
      }),
    );

    // The persisted ipHash MUST NOT equal the raw IP — it must be the hex
    // hash, AND it must be derived from the daily salt. Comparing against
    // hashIP(ip, 'test-salt') (the daily-salt mock value) guards against a
    // regression that falls back to IP_HASH_SALT_BOOTSTRAP.
    const callArgs = insertEventIfNotRecentMock.mock.calls[0]?.[1];
    expect(callArgs?.ipHash).toBeDefined();
    expect(callArgs?.ipHash).not.toBe('1.2.3.4');
    expect(callArgs?.ipHash).toMatch(/^[0-9a-f]{64}$/);
    const expectedHash = await hashIP('1.2.3.4', 'test-salt');
    expect(callArgs?.ipHash).toBe(expectedHash);
  });

  it('skips tracking for placeholder ad but still 302s', async () => {
    const { ctx, redirectMock } = makeCtx({
      adRow: { link_url: 'https://example.com/p', kind: 'placeholder' },
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const res = await handleClick(ctx);
    expect(res.status).toBe(302);
    expect(redirectMock).toHaveBeenCalledWith('https://example.com/p', 302);
    expect(insertEventIfNotRecentMock).not.toHaveBeenCalled();
    expect(getDailySaltMock).not.toHaveBeenCalled();
  });

  it('skips tracking on HEAD method', async () => {
    const { ctx, redirectMock } = makeCtx({ method: 'HEAD' });
    const res = await handleClick(ctx);
    expect(res.status).toBe(302);
    expect(redirectMock).toHaveBeenCalled();
    expect(insertEventIfNotRecentMock).not.toHaveBeenCalled();
  });

  it('skips tracking for bot UA', async () => {
    const { ctx, redirectMock } = makeCtx({
      headers: { 'user-agent': 'Googlebot/2.1' },
    });
    const res = await handleClick(ctx);
    expect(res.status).toBe(302);
    expect(redirectMock).toHaveBeenCalled();
    expect(insertEventIfNotRecentMock).not.toHaveBeenCalled();
  });

  it('still 302s when dedup helper reports duplicate (no extra DB writes)', async () => {
    insertEventIfNotRecentMock.mockResolvedValueOnce({ ok: false, reason: 'duplicate' });
    const { ctx, redirectMock } = makeCtx({
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const res = await handleClick(ctx);
    expect(res.status).toBe(302);
    expect(redirectMock).toHaveBeenCalled();
    expect(insertEventIfNotRecentMock).toHaveBeenCalledTimes(1);
  });

  it('redirects normally even when tracking insert throws', async () => {
    insertEventIfNotRecentMock.mockRejectedValueOnce(new Error('db boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, redirectMock } = makeCtx({
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const res = await handleClick(ctx);
    expect(res.status).toBe(302);
    expect(redirectMock).toHaveBeenCalledWith('https://example.com/landing', 302);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('records click for house ad', async () => {
    const { ctx, redirectMock } = makeCtx({
      adRow: { link_url: 'https://example.com/h', kind: 'house' },
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const res = await handleClick(ctx);
    expect(res.status).toBe(302);
    expect(redirectMock).toHaveBeenCalledWith('https://example.com/h', 302);
    expect(insertEventIfNotRecentMock).toHaveBeenCalledTimes(1);
  });
});
