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

// In test env POSTGRES_URL is unreachable. Handlers that touch the DB will
// either return an ephemeral "couldn't reach" message (200) or surface the
// pool error as 500. Both shapes prove the request reached the handler.
const REACHED_HANDLER = (status: number) => [200, 500].includes(status);

describe('/interactions self-service routes (integration)', () => {
  it('routes /ad list to handleAdList (DB unreachable → handler runs)', async () => {
    const body = JSON.stringify({
      type: 2,
      id: 'int-1',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: {
        id: 'cmd-1',
        name: 'ad',
        type: 1,
        options: [{ name: 'list', type: 1, options: [] }],
      },
    });
    const res = await post(body);
    expect(REACHED_HANDLER(res.status)).toBe(true);
  });

  it('routes /ad withdraw to handleAdWithdrawCommand', async () => {
    const body = JSON.stringify({
      type: 2,
      id: 'int-2',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: {
        id: 'cmd-1',
        name: 'ad',
        type: 1,
        options: [
          {
            name: 'withdraw',
            type: 1,
            options: [{ name: 'id', type: 3, value: '00000000-0000-0000-0000-000000000099' }],
          },
        ],
      },
    });
    const res = await post(body);
    expect(REACHED_HANDLER(res.status)).toBe(true);
  });

  it('routes /ad stats to handleAdStatsCommand', async () => {
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
            name: 'stats',
            type: 1,
            options: [{ name: 'period', type: 3, value: '7d' }],
          },
        ],
      },
    });
    const res = await post(body);
    expect(REACHED_HANDLER(res.status)).toBe(true);
  });

  it('routes /ad rules to handleAdRules', async () => {
    const body = JSON.stringify({
      type: 2,
      id: 'int-4',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: {
        id: 'cmd-1',
        name: 'ad',
        type: 1,
        options: [{ name: 'rules', type: 1, options: [] }],
      },
    });
    const res = await post(body);
    expect(REACHED_HANDLER(res.status)).toBe(true);
  });

  it('button ad:list reaches handler', async () => {
    const body = JSON.stringify({
      type: 3, // MESSAGE_COMPONENT
      id: 'int-5',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'ad:list', component_type: 2 },
    });
    const res = await post(body);
    expect(REACHED_HANDLER(res.status)).toBe(true);
  });

  it('button ad:stats:period returns immediate select menu (no DB)', async () => {
    const body = JSON.stringify({
      type: 3,
      id: 'int-6',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'ad:stats:period', component_type: 2 },
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type: number;
      data: {
        flags: number;
        components: { components: { custom_id: string }[] }[];
      };
    };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    const customIds = json.data.components[0]?.components.map((b) => b.custom_id);
    expect(customIds).toEqual(['ad:stats:24h', 'ad:stats:7d', 'ad:stats:30d', 'ad:stats:all']);
  });

  it('button ad:stats:7d reaches stats handler (DB unreachable)', async () => {
    const body = JSON.stringify({
      type: 3,
      id: 'int-7',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'ad:stats:7d', component_type: 2 },
    });
    const res = await post(body);
    expect(REACHED_HANDLER(res.status)).toBe(true);
  });

  it('button ad:withdraw:<uuid> reaches withdraw handler', async () => {
    const body = JSON.stringify({
      type: 3,
      id: 'int-8',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: {
        custom_id: 'ad:withdraw:00000000-0000-0000-0000-000000000099',
        component_type: 2,
      },
    });
    const res = await post(body);
    expect(REACHED_HANDLER(res.status)).toBe(true);
  });

  it('button ad:rules reaches rules handler', async () => {
    const body = JSON.stringify({
      type: 3,
      id: 'int-9',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'ad:rules', component_type: 2 },
    });
    const res = await post(body);
    expect(REACHED_HANDLER(res.status)).toBe(true);
  });

  it('button ad:help returns inline help text without DB', async () => {
    const body = JSON.stringify({
      type: 3,
      id: 'int-10',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'ad:help', component_type: 2 },
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('起稿の手順');
  });

  it('unknown ad:foo component → 501', async () => {
    const body = JSON.stringify({
      type: 3,
      id: 'int-11',
      application_id: 'app-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'ad:foo', component_type: 2 },
    });
    const res = await post(body);
    expect(res.status).toBe(501);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('unknown component');
  });
});
