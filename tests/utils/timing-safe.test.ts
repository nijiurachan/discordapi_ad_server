import { describe, expect, it } from 'vitest';
import { timingSafeEqualBytes, timingSafeEqualStrings } from '../../src/utils/timing-safe.ts';

describe('timingSafeEqualBytes', () => {
  it('true for equal arrays', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
  it('false for different lengths', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
  it('false for different bytes', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
});

describe('timingSafeEqualStrings', () => {
  it('true for equal strings', () => {
    expect(timingSafeEqualStrings('abc', 'abc')).toBe(true);
  });
  it('false for different strings', () => {
    expect(timingSafeEqualStrings('abc', 'abd')).toBe(false);
  });
  it('false when null/undefined', () => {
    expect(timingSafeEqualStrings(null, 'x')).toBe(false);
    expect(timingSafeEqualStrings(undefined, 'x')).toBe(false);
    expect(timingSafeEqualStrings('x', undefined)).toBe(false);
  });
  it('handles unicode correctly', () => {
    expect(timingSafeEqualStrings('日本', '日本')).toBe(true);
    expect(timingSafeEqualStrings('日本', '日米')).toBe(false);
  });
});
