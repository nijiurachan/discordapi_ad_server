import { timingSafeEqualBytes } from '../utils/timing-safe.ts';

const TOKEN_PREFIX = 'v1.';
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type ImpressionTokenScope = {
  adId: string;
  slot: string;
  ipHash: string;
};

function buildMessage(scope: ImpressionTokenScope, servedAt: Date): string {
  return `${scope.adId}|${scope.slot}|${servedAt.toISOString()}|${scope.ipHash}`;
}

async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return new Uint8Array(sig);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  // btoa is available in Workers
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array | null {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? norm : norm + '='.repeat(4 - (norm.length % 4));
  try {
    const bin = atob(pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function generateImpressionToken(
  scope: ImpressionTokenScope,
  servedAt: Date,
  secret: string,
): Promise<string> {
  const sig = await hmacSha256(secret, buildMessage(scope, servedAt));
  // Pack: <base64url-iso-timestamp>.<base64url-hmac>
  // Including the timestamp lets the verifier check TTL without external state.
  const ts = servedAt.toISOString();
  const tsBytes = new TextEncoder().encode(ts);
  return `${TOKEN_PREFIX}${bytesToBase64Url(tsBytes)}.${bytesToBase64Url(sig)}`;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: 'malformed' | 'expired' | 'mismatch' };

export async function verifyImpressionToken(
  token: string,
  scope: ImpressionTokenScope,
  secret: string,
  now: Date = new Date(),
): Promise<VerifyResult> {
  if (!token.startsWith(TOKEN_PREFIX)) return { valid: false, reason: 'malformed' };
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return { valid: false, reason: 'malformed' };

  const tsB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);

  const tsBytes = base64UrlToBytes(tsB64);
  if (!tsBytes) return { valid: false, reason: 'malformed' };
  let servedAt: Date;
  try {
    const tsStr = new TextDecoder().decode(tsBytes);
    servedAt = new Date(tsStr);
    if (Number.isNaN(servedAt.getTime())) return { valid: false, reason: 'malformed' };
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  const sigBytes = base64UrlToBytes(sigB64);
  if (!sigBytes) return { valid: false, reason: 'malformed' };

  if (now.getTime() - servedAt.getTime() > TOKEN_TTL_MS) {
    return { valid: false, reason: 'expired' };
  }
  if (servedAt.getTime() > now.getTime() + 5_000) {
    // future-dated by more than 5s → reject
    return { valid: false, reason: 'malformed' };
  }

  const expected = await hmacSha256(secret, buildMessage(scope, servedAt));
  if (!timingSafeEqualBytes(expected, sigBytes)) {
    return { valid: false, reason: 'mismatch' };
  }
  return { valid: true };
}
