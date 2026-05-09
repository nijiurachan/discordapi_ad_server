import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ImpressionTokenScope,
  generateImpressionToken,
  verifyImpressionToken,
} from '../../src/serve/token.ts';

const SECRET = 'test-impression-secret-1234567890abcdef';

const scope: ImpressionTokenScope = {
  adId: '00000000-0000-0000-0000-000000000001',
  slot: 'default',
  ipHash: 'abcd1234',
};

describe('impression token', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips: generate then verify within TTL', async () => {
    const servedAt = new Date('2026-05-09T12:00:00.000Z');
    const token = await generateImpressionToken(scope, servedAt, SECRET);
    expect(token.startsWith('v1.')).toBe(true);

    const now = new Date('2026-05-09T12:02:00.000Z'); // 2 min later
    const res = await verifyImpressionToken(token, scope, SECRET, now);
    expect(res).toEqual({ valid: true });
  });

  it('rejects token after TTL (5 min)', async () => {
    const servedAt = new Date('2026-05-09T12:00:00.000Z');
    const token = await generateImpressionToken(scope, servedAt, SECRET);
    const now = new Date('2026-05-09T12:06:00.000Z'); // 6 min later
    const res = await verifyImpressionToken(token, scope, SECRET, now);
    expect(res).toEqual({ valid: false, reason: 'expired' });
  });

  it('valid at exactly TTL boundary (5 min)', async () => {
    const servedAt = new Date('2026-05-09T12:00:00.000Z');
    const token = await generateImpressionToken(scope, servedAt, SECRET);
    const now = new Date('2026-05-09T12:05:00.000Z'); // exactly +5 min
    const res = await verifyImpressionToken(token, scope, SECRET, now);
    expect(res).toEqual({ valid: true });
  });

  it('expired 1ms past TTL boundary', async () => {
    const servedAt = new Date('2026-05-09T12:00:00.000Z');
    const token = await generateImpressionToken(scope, servedAt, SECRET);
    const now = new Date('2026-05-09T12:05:00.001Z'); // 1ms past
    const res = await verifyImpressionToken(token, scope, SECRET, now);
    expect(res).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects token from a different scope', async () => {
    const servedAt = new Date('2026-05-09T12:00:00.000Z');
    const token = await generateImpressionToken(scope, servedAt, SECRET);
    const tampered: ImpressionTokenScope = { ...scope, adId: 'other-ad' };
    const res = await verifyImpressionToken(
      token,
      tampered,
      SECRET,
      new Date('2026-05-09T12:01:00.000Z'),
    );
    expect(res).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects token signed with a different secret', async () => {
    const servedAt = new Date('2026-05-09T12:00:00.000Z');
    const token = await generateImpressionToken(scope, servedAt, SECRET);
    const res = await verifyImpressionToken(
      token,
      scope,
      'a-different-secret',
      new Date('2026-05-09T12:01:00.000Z'),
    );
    expect(res).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects malformed prefix', async () => {
    const res = await verifyImpressionToken('v0.bad.token', scope, SECRET);
    expect(res).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects token without dot separator', async () => {
    const res = await verifyImpressionToken('v1.notadottedvalue', scope, SECRET);
    expect(res).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects token with non-base64 signature', async () => {
    // tsB64 = 'aGVsbG8' (decodes to "hello"; not a valid date) — should be malformed
    const res = await verifyImpressionToken('v1.aGVsbG8.!!!', scope, SECRET);
    expect(res).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects future-dated tokens beyond 5s tolerance', async () => {
    const servedAt = new Date('2026-05-09T12:00:30.000Z');
    const token = await generateImpressionToken(scope, servedAt, SECRET);
    const now = new Date('2026-05-09T12:00:00.000Z'); // 30s in the past
    const res = await verifyImpressionToken(token, scope, SECRET, now);
    expect(res).toEqual({ valid: false, reason: 'malformed' });
  });
});
