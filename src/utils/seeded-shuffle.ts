/**
 * Deterministic Fisher-Yates shuffle, seeded by an arbitrary string so the same
 * (input, seed) always produces the same output. Used by the /serve rotation
 * deck so two Worker isolates handling concurrent requests build identical
 * bags for the same (slot, day).
 *
 * The RNG is a tiny xorshift32 driven from the first 4 bytes of SHA-256(seed),
 * which is good enough for permutation purposes (we don't need cryptographic
 * unpredictability — only that the order be stable and well-mixed).
 */

async function seedToUint32(seed: string): Promise<number> {
  const data = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const view = new DataView(digest);
  // Force non-zero (xorshift requires non-zero state). The probability of all
  // 32 bits being zero is 2^-32, but guard anyway.
  const s = view.getUint32(0, true);
  return s === 0 ? 1 : s;
}

function xorshift32(state: { s: number }): number {
  let x = state.s;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  // Coerce back to uint32 — JS bitwise ops produce signed int32; >>> 0 lifts.
  state.s = x >>> 0;
  return state.s;
}

/**
 * Returns a new array with the same elements as `input`, shuffled by a
 * Fisher-Yates pass driven by a seeded xorshift32 RNG.
 */
export async function seededShuffle<T>(input: readonly T[], seed: string): Promise<T[]> {
  const out = input.slice();
  if (out.length <= 1) return out;
  const state = { s: await seedToUint32(seed) };
  // Fisher-Yates from end backwards.
  for (let i = out.length - 1; i > 0; i--) {
    // Unbiased index in [0, i] from a uint32 by rejection-sampling the smallest
    // multiple of (i + 1) that fits in 2^32.
    const range = i + 1;
    const limit = Math.floor(0x100000000 / range) * range;
    let r: number;
    do {
      r = xorshift32(state);
    } while (r >= limit);
    const j = r % range;
    const tmp = out[i];
    out[i] = out[j] as T;
    out[j] = tmp as T;
  }
  return out;
}

/**
 * Stable hex digest of a string, used to compute the (id, weight) signature
 * that tells us whether the live ad set has diverged from the deck we cached.
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
