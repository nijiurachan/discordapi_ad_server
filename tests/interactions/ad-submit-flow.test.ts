import { SELF } from 'cloudflare:test';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { toHex } from '../_helpers/hex.ts';

const keypair = nacl.sign.keyPair();
const publicKeyHex = toHex(keypair.publicKey);

function sign(timestamp: string, body: string) {
  const msg = new TextEncoder().encode(timestamp + body);
  return toHex(nacl.sign.detached(msg, keypair.secretKey));
}

async function post(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(ts, body);
  return SELF.fetch('http://example.com/interactions', {
    method: 'POST',
    headers: {
      'X-Signature-Ed25519': sig,
      'X-Signature-Timestamp': ts,
      'Content-Type': 'application/json',
      'X-Public-Key-Override': publicKeyHex,
    },
    body,
  });
}

describe('/interactions router → command/modal dispatch (integration)', () => {
  it('returns 501 with "unknown command" for an unrecognized application command', async () => {
    const body = JSON.stringify({
      type: 2, // APPLICATION_COMMAND
      id: 'int-1',
      application_id: 'app-1',
      data: { id: 'cmd-1', name: 'unknown', type: 1, options: [] },
    });
    const res = await post(body);
    expect(res.status).toBe(501);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('unknown command');
  });

  it('returns 501 with "unknown ad subcommand" when /ad has no submit subcommand', async () => {
    const body = JSON.stringify({
      type: 2,
      id: 'int-1',
      application_id: 'app-1',
      data: {
        id: 'cmd-1',
        name: 'ad',
        type: 1,
        options: [{ name: 'other', type: 1, options: [] }],
      },
    });
    const res = await post(body);
    expect(res.status).toBe(501);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('unknown ad subcommand');
  });

  it('returns 501 with "unknown modal" for a modal submit with unrecognized custom_id', async () => {
    const body = JSON.stringify({
      type: 5, // MODAL_SUBMIT
      id: 'int-2',
      application_id: 'app-1',
      data: { custom_id: 'other:abc', components: [] },
    });
    const res = await post(body);
    expect(res.status).toBe(501);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('unknown modal');
  });

  it('routes /ad submit to the handler (DB unreachable in test env → handler returns)', async () => {
    // The miniflare test bindings point POSTGRES_URL at an unreachable host,
    // so handleAdSubmit will fail when it tries to open a pool. We assert the
    // request reaches the handler (doesn't return the dispatch-level 501).
    const body = JSON.stringify({
      type: 2,
      id: 'int-3',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: {
        id: 'cmd-1',
        name: 'ad',
        type: 1,
        options: [
          {
            name: 'submit',
            type: 1,
            options: [
              { name: 'slot', type: 3, value: 'default' },
              { name: 'image', type: 11, value: 'att-1' },
            ],
          },
        ],
        resolved: {
          attachments: {
            'att-1': {
              id: 'att-1',
              url: 'https://example.invalid/x.png',
              filename: 'x.png',
              content_type: 'image/png',
              size: 100,
            },
          },
        },
      },
    });
    const res = await post(body);
    // In test env with unreachable DB the handler may either:
    //   - 200 ephemeral (caught the DB error and returned a user-facing
    //     message), or
    //   - 500 (error escaped without ephemeral wrapping).
    // Both shapes prove the request reached the handler (i.e. it isn't the
    // dispatch-level 501 "unknown command"); only the 200 path has a body
    // shape worth asserting.
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as {
        type: number;
        data?: { content?: string; flags?: number };
      };
      // Ephemeral interaction response: type=4 (CHANNEL_MESSAGE_WITH_SOURCE),
      // flags=64 (EPHEMERAL bit).
      expect(body.type).toBe(4);
      expect(body.data?.flags).toBe(64);
      expect(typeof body.data?.content).toBe('string');
    }
  });

  it('routes submit modal to the handler (DB unreachable in test env → handler returns)', async () => {
    const body = JSON.stringify({
      type: 5,
      id: 'int-4',
      application_id: 'app-1',
      data: {
        custom_id: 'submit:00000000-0000-0000-0000-000000000099',
        components: [
          {
            type: 1,
            components: [{ type: 4, custom_id: 'title', value: 'My Ad' }],
          },
          {
            type: 1,
            components: [{ type: 4, custom_id: 'body', value: 'Hello' }],
          },
          {
            type: 1,
            components: [{ type: 4, custom_id: 'link_url', value: 'https://example.com' }],
          },
        ],
      },
    });
    const res = await post(body);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as {
        type: number;
        data?: { content?: string; flags?: number };
      };
      expect(body.type).toBe(4);
      expect(body.data?.flags).toBe(64);
      expect(typeof body.data?.content).toBe('string');
    }
  });

  it('returns 400 when payload is missing the type field', async () => {
    const res = await post('{"foo":"bar"}');
    expect(res.status).toBe(400);
  });
});
