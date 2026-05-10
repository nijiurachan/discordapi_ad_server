import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { getAdEditable, updateAdContent, updateAdImage } from '../../../src/db/queries/ad-edits.ts';

function mockClient(responses: Array<{ rows?: unknown[]; rowCount?: number }>): PgClient {
  let i = 0;
  return {
    query: vi.fn(async () => {
      const r = responses[i++] ?? {};
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('getAdEditable', () => {
  it('returns null when ad is missing', async () => {
    const client = mockClient([{ rows: [] }]);
    expect(await getAdEditable(client, 'missing')).toBeNull();
  });

  it('maps DB row to camelCase', async () => {
    const client = mockClient([
      { rows: [{ title: 'T', body: 'B', link_url: 'https://x', slot: 'default' }] },
    ]);
    const ad = await getAdEditable(client, 'ad-1');
    expect(ad).toEqual({ title: 'T', body: 'B', linkUrl: 'https://x', slot: 'default' });
  });
});

describe('updateAdContent', () => {
  it('returns true when row was updated', async () => {
    const client = mockClient([{ rowCount: 1 }]);
    expect(
      await updateAdContent(client, 'ad-1', { title: 't', body: 'b', linkUrl: 'https://x' }),
    ).toBe(true);
  });

  it('returns false when no row matched', async () => {
    const client = mockClient([{ rowCount: 0 }]);
    expect(
      await updateAdContent(client, 'missing', { title: 't', body: 'b', linkUrl: 'https://x' }),
    ).toBe(false);
  });
});

describe('updateAdImage', () => {
  it('returns null when ad does not exist', async () => {
    const client = mockClient([{ rows: [] }]);
    const out = await updateAdImage(client, 'missing', {
      imageKey: 'k',
      imageMime: 'image/png',
      imageBytes: 1,
      imageWidth: null,
      imageHeight: null,
    });
    expect(out).toBeNull();
  });

  it('returns previous image_key/mime on success', async () => {
    const client = mockClient([
      { rows: [{ image_key: 'old/key', image_mime: 'image/jpeg' }] },
      { rowCount: 1 },
    ]);
    const out = await updateAdImage(client, 'ad-1', {
      imageKey: 'new/key',
      imageMime: 'image/png',
      imageBytes: 100,
      imageWidth: 800,
      imageHeight: 800,
    });
    expect(out?.previous).toEqual({ imageKey: 'old/key', imageMime: 'image/jpeg' });
  });
});
