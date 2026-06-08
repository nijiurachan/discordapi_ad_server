import { describe, expect, it } from 'vitest';
import { effectiveWeights } from '../../src/sponsors/tier.ts';

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
});
