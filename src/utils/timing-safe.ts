/**
 * Constant-time byte comparison. Returns false for unequal-length inputs
 * without leaking any timing.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Constant-time string equality via UTF-8 byte comparison.
 * Lengths-differ short-circuit is acceptable: leaking the length of a static
 * server-side secret via response timing is still safer than leaking byte-by-byte
 * differences.
 */
export function timingSafeEqualStrings(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  const enc = new TextEncoder();
  return timingSafeEqualBytes(enc.encode(a), enc.encode(b));
}
