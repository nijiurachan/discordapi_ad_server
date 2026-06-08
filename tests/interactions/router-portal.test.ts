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

describe('/interactions router → portal: arm (integration)', () => {
  it('routes portal:open to a deferred ephemeral ACK (type 5)', async () => {
    const body = JSON.stringify({
      type: 3, // MESSAGE_COMPONENT
      id: 'int-portal-1',
      application_id: 'app-1',
      token: 'tok-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'portal:open', component_type: 2 },
    });
    const res = await post(body);
    // portal:open ACKs inline with a DEFERRED ephemeral; the heavy create/render
    // work is scheduled on waitUntil (a no-op DB in the test env is fine — the
    // followup just won't post). The dispatch-level assertion: it is NOT the
    // 501 "unknown component", and the inline ACK is type 5.
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data?: { flags?: number } };
    expect(json.type).toBe(5);
    expect(json.data?.flags).toBe(64);
  });

  it('routes a non-open portal: id (portal:refresh) to the dashboard handler, not the 501 dispatch fallback', async () => {
    // With an unreachable/empty test DB the handler returns a user-facing
    // ephemeral (type 4) rather than the dispatch-level 501 "unknown component".
    const body = JSON.stringify({
      type: 3,
      id: 'int-portal-2',
      application_id: 'app-1',
      token: 'tok-2',
      guild_id: 'guild-1',
      channel_id: 'chan-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'portal:refresh', component_type: 2 },
    });
    const res = await post(body);
    // Reached the handler (not the 501 fallback). In the test env it may 200
    // (ephemeral "ポータルが見つかりません") or 500 (DB error escaped); both prove routing.
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      const json = (await res.json()) as { type: number; data?: { flags?: number } };
      // type 4 ephemeral or type 7 update — never the dispatch 501.
      expect([4, 7]).toContain(json.type);
    }
  });
});
