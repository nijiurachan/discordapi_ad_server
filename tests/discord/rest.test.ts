import { describe, expect, it, vi } from 'vitest';
import { createDiscordRest } from '../../src/discord/rest.ts';

describe('createDiscordRest', () => {
  it('GETs the right URL with bot auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: 'c1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const rest = createDiscordRest({ token: 'tkn', fetch: fetchMock });
    const ch = await rest.getChannel('123');
    expect(ch.id).toBe('c1');
    expect(fetchMock.mock.calls).toHaveLength(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('expected fetch to have been called');
    const [url, init] = firstCall;
    expect(url).toBe('https://discord.com/api/v10/channels/123');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bot tkn',
    });
  });

  it('throws DiscordRestError on non-2xx', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ message: 'unknown' }), { status: 404 }),
    );
    const rest = createDiscordRest({ token: 'tkn', fetch: fetchMock });
    await expect(rest.getChannel('x')).rejects.toThrow(/404/);
  });
});
