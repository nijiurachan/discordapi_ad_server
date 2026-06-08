import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../../src/discord/types.ts';
import {
  type PortalOpenDeps,
  runPortalOpenButton,
} from '../../../src/interactions/buttons/portal-open-button.ts';

function payload(): MessageComponentInteractionPayload {
  return {
    type: 3,
    id: 'i-1',
    application_id: 'app-1',
    token: 'tok-1',
    guild_id: 'g-1',
    member: { user: { id: 's-1', username: 'spon' } },
    data: { custom_id: 'portal:open', component_type: 2 },
  } as unknown as MessageComponentInteractionPayload;
}

function ctx(scheduled: Promise<unknown>[]) {
  const app = new Hono();
  let response: Response | undefined;
  app.post('/', async (c) => {
    // Inject a fake waitUntil that records scheduled promises. The Hono Context's
    // executionCtx is getter-only at runtime (matching review-approve-button), so
    // the scheduler is passed via deps rather than mutated onto the Context.
    response = await runPortalOpenButton(c, payload(), {
      ...deps,
      waitUntil: (p) => {
        scheduled.push(p);
      },
    });
    return response;
  });
  return app;
}

const followup = vi.fn(async () => ({ id: 'm-1', channel_id: 'c-1' }));
// The scheduled work opens a FRESH client inside the waitUntil callback via
// deps.withClient (production: `(fn) => withPgClient(env, fn)`). The test injects
// a withClient that hands the callback a fresh mock client each time — proving
// the request-scoped client is NOT reused.
const mockClient = {
  query: vi.fn(async (sql: string) =>
    /SELECT/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 },
  ),
  end: vi.fn(),
} as unknown as PgClient;
const withClient = vi.fn((fn: (client: PgClient) => Promise<unknown>) =>
  fn(mockClient),
) as unknown as PortalOpenDeps['withClient'] & ReturnType<typeof vi.fn>;
const deps = {
  rest: {
    getChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
    createGuildChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
    createMessage: vi.fn(async () => ({ id: 'dash-1', channel_id: 'c-new' })),
    editMessage: vi.fn(),
    editOriginalInteractionResponse: followup,
    getGuildMember: vi.fn(async () => ({ user: { id: 's-1' }, roles: [] })),
  } as unknown as DiscordRest,
  withClient,
  waitUntil: (_p: Promise<unknown>) => undefined,
  appId: 'app-1',
  guildId: 'g-1',
  botId: 'bot-1',
  categoryId: 'cat-1',
  reviewerRoleId: 'rev',
  adminRoleId: 'adm',
  uuid: () => 'p-1',
};

describe('runPortalOpenButton', () => {
  // Reset shared mocks (followup, withClient) so per-test call counts are exact.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a deferred ephemeral (type 5) immediately', async () => {
    const scheduled: Promise<unknown>[] = [];
    const res = await ctx(scheduled).request('/', { method: 'POST' });
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    // The heavy work was scheduled on waitUntil, not awaited inline.
    expect(scheduled.length).toBe(1);
  });

  it('still sends exactly one followup pointing at the channel when post-open reads throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduled: Promise<unknown>[] = [];
    // A client whose post-open banner read (FROM ads) throws — proving the
    // deferred ACK is never left hanging: the channel exists, so the followup
    // must point at it instead of returning without any editOriginalInteractionResponse.
    const throwingClient = {
      query: vi.fn(async (sql: string) => {
        if (/FROM ads/.test(sql)) throw new Error('post-open read boom');
        return /SELECT/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
      }),
      end: vi.fn(),
    } as unknown as PgClient;
    const localFollowup = vi.fn(async () => ({ id: 'm-1', channel_id: 'c-new' }));
    const app = new Hono();
    app.post('/', async (c) =>
      runPortalOpenButton(c, payload(), {
        ...deps,
        rest: { ...deps.rest, editOriginalInteractionResponse: localFollowup } as DiscordRest,
        withClient: ((fn: (client: PgClient) => Promise<unknown>) =>
          fn(throwingClient)) as PortalOpenDeps['withClient'],
        waitUntil: (p) => {
          scheduled.push(p);
        },
      }),
    );
    await app.request('/', { method: 'POST' });
    await Promise.all(scheduled);
    // Exactly one followup, and it links the created channel (degraded message).
    expect(localFollowup).toHaveBeenCalledTimes(1);
    const [, , body] = localFollowup.mock.calls[0] as unknown as [
      string,
      string,
      { content: string },
    ];
    expect(body.content).toContain('<#c-new>');
    expect(body.content).toContain('情報の取得に失敗');
  });

  it('opens a fresh client inside waitUntil and posts a followup with the channel link', async () => {
    const scheduled: Promise<unknown>[] = [];
    const res = await ctx(scheduled).request('/', { method: 'POST' });
    // The ACK path returns the deferred ephemeral (type 5) without awaiting the
    // heavy work — the open/render/followup is handed to waitUntil and recorded
    // in `scheduled`, proving it is NOT awaited inline by runPortalOpenButton.
    expect((await res.json()) as unknown).toEqual({ type: 5, data: { flags: 64 } });
    expect(scheduled.length).toBe(1);
    await Promise.all(scheduled);
    // The fresh client is opened via withClient (NOT the request-scoped client)
    // inside the scheduled work, exactly once, and the followup links the channel.
    expect(withClient).toHaveBeenCalledTimes(1);
    expect(followup).toHaveBeenCalledTimes(1);
    const [appId, token, body] = followup.mock.calls[0] as unknown as [
      string,
      string,
      { content: string },
    ];
    expect(appId).toBe('app-1');
    expect(token).toBe('tok-1');
    expect(body.content).toContain('<#c-new>');
  });
});
