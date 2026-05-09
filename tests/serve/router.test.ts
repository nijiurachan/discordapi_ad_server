import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseN } from '../../src/serve/router.ts';

describe('parseN', () => {
  it('defaults to 1 when undefined', () => {
    expect(parseN(undefined)).toBe(1);
  });

  it('defaults to 1 when empty string', () => {
    expect(parseN('')).toBe(1);
  });

  it('defaults to 1 for non-numeric input', () => {
    expect(parseN('abc')).toBe(1);
  });

  it('defaults to 1 for zero or negative input', () => {
    expect(parseN('0')).toBe(1);
    expect(parseN('-5')).toBe(1);
  });

  it('clamps to MAX_N (5)', () => {
    expect(parseN('5')).toBe(5);
    expect(parseN('10')).toBe(5);
    expect(parseN('999')).toBe(5);
  });

  it('passes through valid range 1..5', () => {
    expect(parseN('1')).toBe(1);
    expect(parseN('2')).toBe(2);
    expect(parseN('3')).toBe(3);
    expect(parseN('4')).toBe(4);
  });
});

describe('GET /ads/serve route mounting', () => {
  it('returns either 200 / 204 / 500 (route is mounted; DB unreachable in test env is acceptable)', async () => {
    const res = await SELF.fetch('http://example.com/ads/serve?slot=default&n=1');
    // 200=happy, 204=empty, 500=DB unreachable in test env. 404 would mean unmounted.
    expect([200, 204, 500]).toContain(res.status);
  });

  it('rejects POST with 404 (only GET is mounted)', async () => {
    const res = await SELF.fetch('http://example.com/ads/serve', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
