import { SELF } from 'cloudflare:test';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { AdminButtonIds } from '../../../src/discord/admin-menu.ts';
import { toHex } from '../../_helpers/hex.ts';

const keypair = nacl.sign.keyPair();
const publicKeyHex = toHex(keypair.publicKey);

function sign(timestamp: string, body: string) {
  const msg = new TextEncoder().encode(timestamp + body);
  return toHex(nacl.sign.detached(msg, keypair.secretKey));
}

async function postSigned(body: string) {
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

function buttonPayload(customId: string, roles: string[]) {
  return JSON.stringify({
    type: 3, // MESSAGE_COMPONENT
    id: '1',
    application_id: 'app',
    member: {
      user: { id: 'u1' },
      roles,
    },
    data: {
      custom_id: customId,
      component_type: 2,
    },
  });
}

describe('admin buttons (adm:* dispatcher)', () => {
  it('returns ephemeral ACK stub for not-yet-implemented adm:* buttons', async () => {
    // STATS_OVERVIEW is still a stub in P6.3; once P6.9 lands this should be updated.
    const res = await postSigned(buttonPayload(AdminButtonIds.STATS_OVERVIEW, ['6']));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('後続タスク');
  });

  it('rejects non-admin members with permission error (ephemeral)', async () => {
    const res = await postSigned(buttonPayload(AdminButtonIds.STATS_OVERVIEW, ['some-other-role']));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('管理者');
  });

  it('returns ephemeral for unknown adm:* custom_id', async () => {
    const res = await postSigned(buttonPayload('adm:unknown:thing', ['6']));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('未対応');
  });
});
