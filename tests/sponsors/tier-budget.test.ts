import { describe, expect, it } from 'vitest';
import { type EffectiveWeightsResult, effectiveWeights } from '../../src/sponsors/tier.ts';

function snapById(r: EffectiveWeightsResult, id: string): number | undefined {
  return r.weights.find((w) => w.id === id)?.weightSnapshot;
}

describe('effectiveWeights', () => {
  it('S <= T: snapshot equals alloc, nothing paused', () => {
    const r = effectiveWeights(
      [
        { id: 'a', weightAlloc: 50 },
        { id: 'b', weightAlloc: 20 },
        { id: 'c', weightAlloc: 10 },
      ],
      80,
    );
    expect(r.paused).toEqual([]);
    expect(r.weights).toEqual([
      { id: 'a', weightSnapshot: 50 },
      { id: 'b', weightSnapshot: 20 },
      { id: 'c', weightSnapshot: 10 },
    ]);
  });

  it('S > T: proportional rescale, remainder absorbed on largest alloc, sum == T', () => {
    // S = 100, T = 50. raw = 25,10,15 -> round = 25,10,15 (sum 50, no remainder)
    const r = effectiveWeights(
      [
        { id: 'a', weightAlloc: 50 },
        { id: 'b', weightAlloc: 20 },
        { id: 'c', weightAlloc: 30 },
      ],
      50,
    );
    expect(r.paused).toEqual([]);
    const sum = r.weights.reduce((s, w) => s + w.weightSnapshot, 0);
    expect(sum).toBe(50);
    expect(snapById(r, 'a')).toBe(25);
    expect(snapById(r, 'b')).toBe(10);
    expect(snapById(r, 'c')).toBe(15);
  });

  it('S > T: rounding remainder is added to the largest-alloc banner so sum == T', () => {
    // S = 3 (1,1,1), T = 2. raw each = 0.666 -> max(1,round)=1,1,1 sum 3 > T.
    // count(3) > T(2) so smallest-alloc-first pause until count <= T.
    // Tie on alloc=1: pause by ascending alloc then by id; survivors recompute.
    const r = effectiveWeights(
      [
        { id: 'a', weightAlloc: 1 },
        { id: 'b', weightAlloc: 1 },
        { id: 'c', weightAlloc: 1 },
      ],
      2,
    );
    expect(r.paused).toEqual(['a']);
    const sum = r.weights.reduce((s, w) => s + w.weightSnapshot, 0);
    expect(sum).toBe(2);
    expect(r.weights.map((w) => w.id).sort()).toEqual(['b', 'c']);
  });

  it('S > T with a genuine rounding remainder lands on the largest alloc', () => {
    // S = 10 (7,2,1), T = 7. raw = 4.9, 1.4, 0.7 -> round = 5,1,1 sum 7 (=T).
    const r1 = effectiveWeights(
      [
        { id: 'a', weightAlloc: 7 },
        { id: 'b', weightAlloc: 2 },
        { id: 'c', weightAlloc: 1 },
      ],
      7,
    );
    const sum1 = r1.weights.reduce((s, w) => s + w.weightSnapshot, 0);
    expect(sum1).toBe(7);
    // S = 6 (3,2,1), T = 4. raw = 2,1.33,0.66 -> round 2,1,1 sum 4 (=T), no remainder.
    // S = 6 (3,2,1), T = 5. raw = 2.5,1.66,0.83 -> round 3,2,1 sum 6 != 5;
    //   remainder = 5 - 6 = -1 absorbed on largest alloc 'a' -> 2,2,1 sum 5.
    const r2 = effectiveWeights(
      [
        { id: 'a', weightAlloc: 3 },
        { id: 'b', weightAlloc: 2 },
        { id: 'c', weightAlloc: 1 },
      ],
      5,
    );
    const sum2 = r2.weights.reduce((s, w) => s + w.weightSnapshot, 0);
    expect(sum2).toBe(5);
    expect(snapById(r2, 'a')).toBe(2);
    expect(snapById(r2, 'b')).toBe(2);
    expect(snapById(r2, 'c')).toBe(1);
  });

  it('negative-remainder min-1 floor: absorber never drops below 1, residual rolls to next-largest, Σ==T', () => {
    // allocs [3,3,1,1], S=10, T=4, count 4 <= 4 so NO pause.
    // raw = 1.5,1.5,0.5,0.5 -> round (half-up) = 2,2,1,1, sum = 6.
    // remainder = T - 6 = -2. Absorb largest-first WITHOUT going below 1:
    //   a (alloc 3, snap 2) can take 1 -> a=1, residual -1
    //   b (alloc 3, snap 2) can take 1 -> b=1, residual 0
    // Result: 1,1,1,1, Σ == 4 == T, every weight >= 1 (a did NOT go to 0).
    const r = effectiveWeights(
      [
        { id: 'a', weightAlloc: 3 },
        { id: 'b', weightAlloc: 3 },
        { id: 'c', weightAlloc: 1 },
        { id: 'd', weightAlloc: 1 },
      ],
      4,
    );
    expect(r.paused).toEqual([]);
    const sum = r.weights.reduce((s, w) => s + w.weightSnapshot, 0);
    expect(sum).toBe(4);
    // Critical invariant: no survivor weight is below the min of 1.
    expect(r.weights.every((w) => w.weightSnapshot >= 1)).toBe(true);
    expect(snapById(r, 'a')).toBe(1); // absorber clamped at 1, not 0
    expect(snapById(r, 'b')).toBe(1); // residual rolled here, also clamped at 1
    expect(snapById(r, 'c')).toBe(1);
    expect(snapById(r, 'd')).toBe(1);
  });
});

import { vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { getSponsorBudget, sumActiveWeight } from '../../src/sponsors/tier.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };
function mockClient(
  responses: Array<{ rows: unknown[] }>,
  captured: CapturedCall[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return responses[i++] ?? { rows: [] };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('sumActiveWeight', () => {
  it('returns SUM(weight_alloc) over pending+approved regular ads', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient([{ rows: [{ used: 70 }] }], captured);
    const used = await sumActiveWeight(client, 'sp-1');
    expect(used).toBe(70);
    expect(captured[0]?.params).toEqual(['sp-1']);
    expect(captured[0]?.sql).toMatch(/SUM\(weight_alloc\)/);
    expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
    expect(captured[0]?.sql).toMatch(/status IN \('pending', 'approved'\)/);
  });

  it('returns 0 when there are no active ads', async () => {
    const client = mockClient([{ rows: [{ used: null }] }]);
    expect(await sumActiveWeight(client, 'sp-2')).toBe(0);
  });
});
