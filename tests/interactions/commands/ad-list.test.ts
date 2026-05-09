import type { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { Bindings } from '../../../src/env.ts';
import { type AdListDeps, runAdList } from '../../../src/interactions/commands/ad-list.ts';

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

const mockS3 = (): S3Client => ({ send: vi.fn() }) as unknown as S3Client;

function makeAdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ad-1',
    slot: 'default',
    title: 'Title 1',
    body: 'Body 1',
    link_url: 'https://example.com',
    image_key: 'staging/abc/orig.png',
    image_mime: 'image/png',
    status: 'pending',
    weight_snapshot: null,
    created_at: new Date('2026-05-09T12:00:00Z'),
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

async function invoke(deps: AdListDeps, userId = 'user-1'): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAdList(c, userId, deps));
  return app.request('http://test/', { method: 'POST' });
}

describe('runAdList', () => {
  it('empty result → ephemeral "まだ広告が登録されていません"', async () => {
    const client = mockClient([{ rows: [] }]);
    const res = await invoke({
      client,
      s3: mockS3(),
      bucket: 'b',
      presignTtlSeconds: 300,
      presignImpl: vi.fn(),
    });
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('まだ広告が登録されていません');
  });

  it('3 ads → 3 embeds with image url; presign called per image', async () => {
    const client = mockClient([
      {
        rows: [
          makeAdRow({ id: 'ad-1', status: 'pending' }),
          makeAdRow({ id: 'ad-2', status: 'approved', image_key: 'staging/2/orig.jpg' }),
          makeAdRow({ id: 'ad-3', status: 'rejected', image_key: null }),
        ],
      },
    ]);
    const presign = vi.fn(async (_s3, _bucket, key: string) => `https://signed/${key}`);
    const res = await invoke({
      client,
      s3: mockS3(),
      bucket: 'b',
      presignTtlSeconds: 300,
      presignImpl: presign,
    });
    const json = (await res.json()) as {
      type: number;
      data: {
        flags: number;
        embeds: { title: string; image?: { url: string } }[];
        components: unknown[];
      };
    };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.embeds).toHaveLength(3);
    expect(presign).toHaveBeenCalledTimes(2); // ad-3 has null image_key
    expect(json.data.embeds[0]?.image?.url).toBe('https://signed/staging/abc/orig.png');
    expect(json.data.embeds[1]?.image?.url).toBe('https://signed/staging/2/orig.jpg');
    expect(json.data.embeds[2]?.image).toBeUndefined();
    // Withdraw buttons for ad-1 (pending) and ad-2 (approved); ad-3 rejected → no button.
    expect(json.data.components).toHaveLength(2);
  });

  it('continues building embeds when one presign throws', async () => {
    const client = mockClient([
      {
        rows: [
          makeAdRow({ id: 'ad-1', status: 'pending', image_key: 'staging/1/orig.png' }),
          makeAdRow({ id: 'ad-2', status: 'approved', image_key: 'staging/2/orig.jpg' }),
          makeAdRow({ id: 'ad-3', status: 'paused', image_key: 'staging/3/orig.png' }),
        ],
      },
    ]);
    let callIdx = 0;
    const presign = vi.fn(async (_s3, _bucket, key: string) => {
      callIdx += 1;
      if (callIdx === 2) throw new Error('presign blew up');
      return `https://signed/${key}`;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await invoke({
        client,
        s3: mockS3(),
        bucket: 'b',
        presignTtlSeconds: 300,
        presignImpl: presign,
      });
      const json = (await res.json()) as {
        type: number;
        data: {
          flags: number;
          embeds: { title: string; image?: { url: string } }[];
          components: unknown[];
        };
      };
      expect(json.type).toBe(4);
      expect(json.data.embeds).toHaveLength(3);
      expect(json.data.embeds[0]?.image?.url).toBe('https://signed/staging/1/orig.png');
      expect(json.data.embeds[1]?.image).toBeUndefined();
      expect(json.data.embeds[2]?.image?.url).toBe('https://signed/staging/3/orig.png');
      expect(presign).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('5 ads → "直近 5 件" notice and only withdrawable ads get a button row', async () => {
    const rows = [
      makeAdRow({ id: 'ad-1', status: 'pending' }),
      makeAdRow({ id: 'ad-2', status: 'approved' }),
      makeAdRow({ id: 'ad-3', status: 'paused' }),
      makeAdRow({ id: 'ad-4', status: 'rejected' }),
      makeAdRow({ id: 'ad-5', status: 'expired' }),
    ];
    const client = mockClient([{ rows }]);
    const presign = vi.fn(async () => 'https://signed/x');
    const res = await invoke({
      client,
      s3: mockS3(),
      bucket: 'b',
      presignTtlSeconds: 300,
      presignImpl: presign,
    });
    const json = (await res.json()) as {
      data: {
        content: string;
        embeds: unknown[];
        components: { components: { custom_id: string; label: string }[] }[];
      };
    };
    expect(json.data.content).toContain('直近 5 件');
    expect(json.data.embeds).toHaveLength(5);
    // Only pending/approved/paused get buttons → 3 rows.
    expect(json.data.components).toHaveLength(3);
    expect(json.data.components[0]?.components[0]?.custom_id).toBe('ad:withdraw:ad-1');
    expect(json.data.components[1]?.components[0]?.custom_id).toBe('ad:withdraw:ad-2');
    expect(json.data.components[2]?.components[0]?.custom_id).toBe('ad:withdraw:ad-3');
  });
});
