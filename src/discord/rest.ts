const BASE_URL = 'https://discord.com/api/v10';

export class DiscordRestError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`Discord API error ${status}: ${bodyText.slice(0, 200)}`);
    this.name = 'DiscordRestError';
  }
}

export type DiscordRestOptions = {
  token: string;
  fetch?: typeof fetch;
};

type Json = Record<string, unknown>;

async function request<T>(
  opts: Required<DiscordRestOptions>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Json,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bot ${opts.token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await opts.fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new DiscordRestError(res.status, text);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export type Channel = { id: string; name?: string; type: number };
export type Message = { id: string; channel_id: string };

export function createDiscordRest(o: DiscordRestOptions) {
  const opts = { token: o.token, fetch: o.fetch ?? fetch };
  return {
    getChannel: (id: string) => request<Channel>(opts, 'GET', `/channels/${id}`),
    deleteChannel: (id: string) => request<Channel>(opts, 'DELETE', `/channels/${id}`),
    createDmChannel: (recipientId: string) =>
      request<Channel>(opts, 'POST', '/users/@me/channels', { recipient_id: recipientId }),
    createMessage: (channelId: string, body: Json) =>
      request<Message>(opts, 'POST', `/channels/${channelId}/messages`, body),
    editMessage: (channelId: string, messageId: string, body: Json) =>
      request<Message>(opts, 'PATCH', `/channels/${channelId}/messages/${messageId}`, body),
    createGuildChannel: (guildId: string, body: Json) =>
      request<Channel>(opts, 'POST', `/guilds/${guildId}/channels`, body),
  };
}

export type DiscordRest = ReturnType<typeof createDiscordRest>;
