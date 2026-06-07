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

/**
 * Attempt to swap positions i and j in `arr` and keep the change only when it
 * does not create any new adjacent duplicate inside the disturbed region
 * (positions i-1..i+1 and j-1..j+1). Returns true on success.
 *
 * Strictly deterministic — used by spreadShuffle as a constraint-aware swap
 * primitive after a seeded random shuffle. Restores the original values on
 * rejection so the caller can keep trying alternative `j`s without bookkeeping.
 */
function trySwap<T>(arr: T[], i: number, j: number): boolean {
  if (i === j) return false;
  const a = arr[i];
  const b = arr[j];
  if (a === undefined || b === undefined) return false;
  if (a === b) return false; // pointless
  arr[i] = b;
  arr[j] = a;
  const positions = new Set([i - 1, i, i + 1, j - 1, j, j + 1]);
  for (const p of positions) {
    if (p <= 0 || p >= arr.length) continue;
    if (arr[p] === arr[p - 1]) {
      arr[i] = a;
      arr[j] = b;
      return false;
    }
  }
  return true;
}

/**
 * Take an already shuffled deck and "spread" it so the same value never (or
 * as rarely as possible) appears at consecutive indices. For each consecutive
 * duplicate `arr[i] === arr[i-1]`, scan forward for the first later position
 * j where swapping arr[i] with arr[j] removes the local duplicate without
 * creating a new one anywhere in the swap region. Repeats sweeps until a
 * full pass makes no swaps (= stable) or MAX_SWEEPS is reached.
 *
 * No-consecutive is mathematically achievable iff max(multiplicity) <=
 * ceil(length / 2). When some value's multiplicity exceeds that bound this
 * function does its best and leaves the unavoidable residual duplicates in
 * place — the user-facing trade-off is "as spread as possible".
 *
 * Deterministic given the input, so callers can cache the result by deck
 * identity (we exploit this via the serve_rotation table).
 */
export function spreadShuffle<T>(deck: readonly T[]): T[] {
  if (deck.length <= 1) return deck.slice();
  const result = deck.slice();
  // Four passes is plenty: each pass at most halves the residual duplicate
  // count in the typical case, and the algorithm provably stabilizes (no
  // swap is accepted unless it strictly reduces a violation).
  const MAX_SWEEPS = 4;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let swaps = 0;
    for (let i = 1; i < result.length; i++) {
      if (result[i] !== result[i - 1]) continue;
      for (let j = i + 1; j < result.length; j++) {
        if (trySwap(result, i, j)) {
          swaps++;
          break;
        }
      }
    }
    if (swaps === 0) break;
  }
  return result;
}
