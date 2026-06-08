import { describe, expect, it, vi } from 'vitest';
import { createDiscordRest } from '../../src/discord/rest.ts';

describe('editOriginalInteractionResponse', () => {
  it('PATCHes /webhooks/{appId}/{token}/messages/@original with bot auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: 'm1', channel_id: 'c1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const rest = createDiscordRest({ token: 'tkn', fetch: fetchMock });
    const msg = await rest.editOriginalInteractionResponse('app-1', 'tok-1', {
      content: 'done',
    });
    expect(msg.id).toBe('m1');
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('expected fetch to have been called');
    const [url, init] = firstCall;
    expect(url).toBe('https://discord.com/api/v10/webhooks/app-1/tok-1/messages/@original');
    expect((init as RequestInit).method).toBe('PATCH');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bot tkn' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ content: 'done' });
  });
});
