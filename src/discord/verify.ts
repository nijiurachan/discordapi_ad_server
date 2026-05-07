import nacl from 'tweetnacl';

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

export type VerifyArgs = {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: string;
};

export async function verifyDiscordSignature(args: VerifyArgs): Promise<boolean> {
  const sig = hexToBytes(args.signatureHex);
  const pub = hexToBytes(args.publicKeyHex);
  if (!sig || !pub) return false;
  const msg = new TextEncoder().encode(args.timestamp + args.body);
  try {
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}
