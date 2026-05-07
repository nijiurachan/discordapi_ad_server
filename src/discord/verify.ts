import nacl from 'tweetnacl';

const HEX_RE = /^[0-9a-fA-F]+$/;

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  if (!HEX_RE.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
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
