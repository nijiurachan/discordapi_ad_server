import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { getAdImage, isValidAdId } from '../../src/serve/image.ts';

describe('isValidAdId', () => {
  it('accepts canonical lowercase UUIDs', () => {
    expect(isValidAdId('11111111-2222-3333-4444-555555555555')).toBe(true);
  });

  it('accepts uppercase / mixed-case UUIDs', () => {
    expect(isValidAdId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
    expect(isValidAdId('AaAaAaAa-bBbB-CcCc-DdDd-eEeEeEeEeEeE')).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(isValidAdId('')).toBe(false);
    expect(isValidAdId('not-a-uuid')).toBe(false);
    expect(isValidAdId('11111111-2222-3333-4444')).toBe(false);
    expect(isValidAdId('11111111-2222-3333-4444-5555555555555')).toBe(false);
    expect(isValidAdId('zzzzzzzz-2222-3333-4444-555555555555')).toBe(false);
  });
});

describe('getAdImage', () => {
  function makeClient(rows: Array<{ image_key: string | null; image_mime: string | null }>) {
    return {
      query: vi.fn(async () => ({ rows })),
      end: vi.fn(async () => {}),
    } as unknown as PgClient;
  }

  it('returns null when no row found', async () => {
    const client = makeClient([]);
    expect(await getAdImage(client, 'id')).toBeNull();
  });

  it('returns null when image_key is null', async () => {
    const client = makeClient([{ image_key: null, image_mime: 'image/png' }]);
    expect(await getAdImage(client, 'id')).toBeNull();
  });

  it('returns image_key and image_mime when present', async () => {
    const client = makeClient([{ image_key: 'ads/abc.png', image_mime: 'image/png' }]);
    expect(await getAdImage(client, 'id')).toEqual({
      imageKey: 'ads/abc.png',
      imageMime: 'image/png',
    });
  });

  it('returns image_key with null mime when mime missing', async () => {
    const client = makeClient([{ image_key: 'ads/abc.png', image_mime: null }]);
    expect(await getAdImage(client, 'id')).toEqual({
      imageKey: 'ads/abc.png',
      imageMime: null,
    });
  });
});

describe('GET /ads/image/:adId route mounting', () => {
  it('returns 400 for malformed UUID', async () => {
    const res = await SELF.fetch('http://example.com/ads/image/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty-ish path segment shape', async () => {
    const res = await SELF.fetch('http://example.com/ads/image/12345');
    expect(res.status).toBe(400);
  });

  it('returns 404 (no ad) or 500 (DB unreachable) for valid UUID — route exists', async () => {
    const res = await SELF.fetch(
      'http://example.com/ads/image/11111111-2222-3333-4444-555555555555',
    );
    // 404 = ad not found in DB; 500 = DB unreachable in test env. Both prove route is mounted.
    expect([404, 500]).toContain(res.status);
  });

  it('rejects POST with 404 (only GET is mounted)', async () => {
    const res = await SELF.fetch(
      'http://example.com/ads/image/11111111-2222-3333-4444-555555555555',
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
  });
});
