import { describe, expect, it } from 'vitest';
import { hashIP } from '../../src/utils/ip-hash.ts';

describe('hashIP', () => {
  it('produces a 64-char lowercase hex string', async () => {
    const out = await hashIP('203.0.113.5', 'salt-v1');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same ip+salt', async () => {
    const a = await hashIP('203.0.113.5', 'salt-v1');
    const b = await hashIP('203.0.113.5', 'salt-v1');
    expect(a).toBe(b);
  });

  it('changes when ip changes', async () => {
    const a = await hashIP('203.0.113.5', 'salt-v1');
    const b = await hashIP('203.0.113.6', 'salt-v1');
    expect(a).not.toBe(b);
  });

  it('changes when salt changes (rotation invalidates old hashes)', async () => {
    const a = await hashIP('203.0.113.5', 'salt-v1');
    const b = await hashIP('203.0.113.5', 'salt-v2');
    expect(a).not.toBe(b);
  });

  it('handles "unknown" sentinel without throwing', async () => {
    const out = await hashIP('unknown', 'salt-v1');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});
