import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { verifyDiscordSignature } from '../../src/discord/verify.ts';

function toHex(u8: Uint8Array) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifyDiscordSignature', () => {
  const keypair = nacl.sign.keyPair();
  const publicKeyHex = toHex(keypair.publicKey);

  it('returns true for a valid signature', async () => {
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const message = new TextEncoder().encode(timestamp + body);
    const sig = toHex(nacl.sign.detached(message, keypair.secretKey));
    const ok = await verifyDiscordSignature({
      publicKeyHex,
      signatureHex: sig,
      timestamp,
      body,
    });
    expect(ok).toBe(true);
  });

  it('returns false for a tampered body', async () => {
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const message = new TextEncoder().encode(timestamp + body);
    const sig = toHex(nacl.sign.detached(message, keypair.secretKey));
    const ok = await verifyDiscordSignature({
      publicKeyHex,
      signatureHex: sig,
      timestamp,
      body: '{"type":2}',
    });
    expect(ok).toBe(false);
  });

  it('returns false when signature hex is malformed', async () => {
    const ok = await verifyDiscordSignature({
      publicKeyHex,
      signatureHex: 'not-hex',
      timestamp: '1',
      body: '',
    });
    expect(ok).toBe(false);
  });
});
