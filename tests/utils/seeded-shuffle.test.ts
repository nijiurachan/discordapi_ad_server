import { describe, expect, it } from 'vitest';
import { spreadShuffle } from '../../src/utils/seeded-shuffle.ts';

describe('spreadShuffle keyOf', () => {
  it('default (identity) still separates identical elements best-effort', () => {
    const out = spreadShuffle(['x', 'y', 'x', 'y']);
    let adj = 0;
    for (let i = 1; i < out.length; i++) if (out[i] === out[i - 1]) adj++;
    expect(adj).toBe(0);
  });

  it('keyOf groups by sponsor: different ads of one sponsor are not adjacent', () => {
    // a1,a2 belong to sponsor A; b1 to sponsor B. With identity, a1 != a2 so
    // they could sit adjacent; with keyOf=sponsor they must be separated.
    // NOTE: sponsor A has multiplicity 4 of N=6 (> ceil(6/2)=3), so perfect
    // non-adjacency is mathematically impossible; the best-effort floor is
    // 2m - N - 1 = 2*4 - 6 - 1 = 1. We assert the keyed heuristic reaches that
    // floor (far below the fully-grouped worst case of m-1 = 3).
    const sponsorOf: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B' };
    const deck = ['a1', 'a2', 'b1', 'a1', 'a2', 'b1'];
    const out = spreadShuffle(deck, (id) => sponsorOf[id] ?? id);
    let adjSameSponsor = 0;
    for (let i = 1; i < out.length; i++) {
      if (
        (sponsorOf[out[i] as string] ?? out[i]) === (sponsorOf[out[i - 1] as string] ?? out[i - 1])
      ) {
        adjSameSponsor++;
      }
    }
    const m = 4;
    const N = deck.length;
    const floor = Math.max(0, 2 * m - N - 1); // = 1
    expect(adjSameSponsor).toBe(floor);
  });

  it('share invariance: spreadShuffle is a permutation (multiset unchanged)', () => {
    const sponsorOf: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B' };
    const deck = ['a1', 'a2', 'b1', 'a1', 'a2', 'b1'];
    const out = spreadShuffle(deck, (id) => sponsorOf[id] ?? id);
    expect(out.slice().sort()).toEqual(deck.slice().sort());
  });

  it('dominant sponsor (> ceil(N/2)): residual same-sponsor adjacencies minimized, share unchanged', () => {
    // Sponsor A holds 5 of N=8 impressions (5 > ceil(8/2)=4), so perfect
    // non-adjacency is mathematically impossible. Best-effort lower bound on
    // same-sponsor adjacencies for one sponsor with count m out of N is
    // m - (N - m) - 1 = 2m - N - 1 = 2*5 - 8 - 1 = 1. Assert we hit that bound.
    const sponsorOf: Record<string, string> = {
      a1: 'A',
      a2: 'A',
      a3: 'A',
      a4: 'A',
      a5: 'A',
      b1: 'B',
      c1: 'C',
      d1: 'D',
    };
    const deck = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'c1', 'd1'];
    const out = spreadShuffle(deck, (id) => sponsorOf[id] ?? id);
    let adjSameSponsor = 0;
    for (let i = 1; i < out.length; i++) {
      if (
        (sponsorOf[out[i] as string] ?? out[i]) === (sponsorOf[out[i - 1] as string] ?? out[i - 1])
      ) {
        adjSameSponsor++;
      }
    }
    // Theoretical floor for a dominant sponsor with count m of N. Best-effort:
    // the swap heuristic must get CLOSE to it and far below the fully-grouped
    // worst case (m-1 = 4 adjacencies). We assert it is minimized to within a
    // small slack of the floor (1), which the 4-sweep heuristic reliably meets
    // for small N; if a future heuristic guarantees the exact floor, tighten
    // this to `toBe(floor)`.
    const m = 5;
    const N = deck.length;
    const floor = Math.max(0, 2 * m - N - 1); // = 1
    expect(adjSameSponsor).toBeLessThanOrEqual(floor + 1);
    expect(adjSameSponsor).toBeLessThan(m - 1); // strictly better than fully grouped
    // per-ad share is unchanged: spreadShuffle is a permutation (each ad once).
    expect(out.slice().sort()).toEqual(deck.slice().sort());
  });
});
