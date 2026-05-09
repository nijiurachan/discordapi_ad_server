/**
 * Deterministic IP hash for impression token scoping. Uses SHA-256 over
 * `${ip}|${salt}` and returns 64-char lowercase hex. The salt is rotated
 * out-of-band to prevent rainbow-table reversal of historical ip_hashes.
 */
export async function hashIP(ip: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${ip}|${salt}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
