import { SELF } from 'cloudflare:test';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

function toHex(u8: Uint8Array) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

const keypair = nacl.sign.keyPair();
const publicKeyHex = toHex(keypair.publicKey);

function sign(timestamp: string, body: string) {
  const msg = new TextEncoder().encode(timestamp + body);
  return toHex(nacl.sign.detached(msg, keypair.secretKey));
}

describe('/interactions', () => {
  it('rejects requests with bad signature with 401', async () => {
    const res = await SELF.fetch('http://example.com/interactions', {
      method: 'POST',
      headers: {
        'X-Signature-Ed25519': '00'.repeat(64),
        'X-Signature-Timestamp': '1',
        'Content-Type': 'application/json',
        'X-Public-Key-Override': publicKeyHex,
      },
      body: '{"type":1}',
    });
    expect(res.status).toBe(401);
  });

  it('responds PONG (type=1) for a signed PING', async () => {
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const sig = sign(timestamp, body);
    const res = await SELF.fetch('http://example.com/interactions', {
      method: 'POST',
      headers: {
        'X-Signature-Ed25519': sig,
        'X-Signature-Timestamp': timestamp,
        'Content-Type': 'application/json',
        'X-Public-Key-Override': publicKeyHex,
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number };
    expect(json.type).toBe(1);
  });
});
