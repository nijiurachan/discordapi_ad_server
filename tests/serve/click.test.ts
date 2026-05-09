import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { getAdLinkUrl, isValidAdId } from '../../src/serve/click.ts';

describe('isValidAdId', () => {
  it('accepts standard 8-4-4-4-12 uuids', () => {
    expect(isValidAdId('00000000-0000-0000-0000-000000000001')).toBe(true);
  });
  it('accepts uppercase / mixed-case UUIDs', () => {
    expect(isValidAdId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
  });
  it('rejects non-hex characters', () => {
    expect(isValidAdId('zzzzzzzz-0000-0000-0000-000000000001')).toBe(false);
  });
  it('rejects wrong hyphen positions', () => {
    expect(isValidAdId('0000000000000000000000000000000000aa')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isValidAdId('')).toBe(false);
  });
});

describe('getAdLinkUrl', () => {
  function makeClient(rows: Array<{ link_url: string }>) {
    return {
      query: vi.fn(async () => ({ rows })),
      end: vi.fn(async () => {}),
    } as unknown as PgClient;
  }

  it('returns null when no row found', async () => {
    const client = makeClient([]);
    expect(await getAdLinkUrl(client, 'id')).toBeNull();
  });

  it('returns the link_url when row present', async () => {
    const client = makeClient([{ link_url: 'https://example.com/landing' }]);
    expect(await getAdLinkUrl(client, 'id')).toBe('https://example.com/landing');
  });
});

describe('/ads/click/:adId route', () => {
  it('400 on invalid uuid', async () => {
    const res = await SELF.fetch('http://example.com/ads/click/not-a-uuid', {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
  });

  it('reaches the route for a valid uuid (DB unreachable in test env -> 500)', async () => {
    const res = await SELF.fetch(
      'http://example.com/ads/click/00000000-0000-0000-0000-000000000001',
      { redirect: 'manual' },
    );
    // Test env DB is unreachable; we only assert the route is mounted (not 404).
    expect(res.status).not.toBe(404);
    expect([200, 302, 400, 500]).toContain(res.status);
  });

  it('ignores ?to= query parameter when computing the redirect target (route reached)', async () => {
    const res = await SELF.fetch(
      'http://example.com/ads/click/00000000-0000-0000-0000-000000000001?to=https://attacker.example',
      { redirect: 'manual' },
    );
    // Route is reached; the actual redirect would use the persisted link_url, not the query.
    // In test env (DB unreachable), we get 500. Just assert the request didn't 302 to attacker.
    if (res.status === 302) {
      const loc = res.headers.get('location') ?? '';
      expect(loc).not.toContain('attacker.example');
    }
  });

  it('POST returns 404 (GET-only)', async () => {
    const res = await SELF.fetch(
      'http://example.com/ads/click/00000000-0000-0000-0000-000000000001',
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
  });
});
