import { describe, expect, it, vi } from 'vitest';
import { createS3Client, getObject } from '../../src/storage/s3.ts';

describe('createS3Client', () => {
  it('returns a client with HeadBucketCommand-capable send()', () => {
    const client = createS3Client({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
    });
    expect(typeof client.send).toBe('function');
  });

  it('throws when endpoint is empty', () => {
    expect(() =>
      createS3Client({ endpoint: '', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b' }),
    ).toThrow(/endpoint/);
  });

  it('throws when region is empty', () => {
    expect(() =>
      createS3Client({ endpoint: 'http://x', region: '', accessKeyId: 'a', secretAccessKey: 'b' }),
    ).toThrow(/region/);
  });

  it('throws when accessKeyId is empty', () => {
    expect(() =>
      createS3Client({ endpoint: 'http://x', region: 'r', accessKeyId: '', secretAccessKey: 'b' }),
    ).toThrow(/accessKeyId/);
  });

  it('throws when secretAccessKey is empty', () => {
    expect(() =>
      createS3Client({ endpoint: 'http://x', region: 'r', accessKeyId: 'a', secretAccessKey: '' }),
    ).toThrow(/secretAccessKey/);
  });
});

describe('getObject', () => {
  it('returns mapped object on success', async () => {
    const fakeBody = new ReadableStream();
    const send = vi.fn(async () => ({
      Body: fakeBody,
      ContentType: 'image/png',
      ContentLength: 12345,
      ETag: '"abc"',
    }));
    const client = { send } as unknown as Parameters<typeof getObject>[0];
    const res = await getObject(client, 'bucket', 'key');
    expect(res?.contentType).toBe('image/png');
    expect(res?.contentLength).toBe(12345);
    expect(res?.etag).toBe('"abc"');
  });

  it('returns null when Body is missing', async () => {
    const send = vi.fn(async () => ({}));
    const client = { send } as unknown as Parameters<typeof getObject>[0];
    const res = await getObject(client, 'bucket', 'key');
    expect(res).toBeNull();
  });

  it('returns null on NoSuchKey', async () => {
    const send = vi.fn(async () => {
      const e = new Error('not found') as Error & { name: string };
      e.name = 'NoSuchKey';
      throw e;
    });
    const client = { send } as unknown as Parameters<typeof getObject>[0];
    const res = await getObject(client, 'bucket', 'key');
    expect(res).toBeNull();
  });

  it('returns null on 404 via $metadata.httpStatusCode', async () => {
    const send = vi.fn(async () => {
      const e = new Error('not found') as Error & { $metadata?: { httpStatusCode?: number } };
      e.$metadata = { httpStatusCode: 404 };
      throw e;
    });
    const client = { send } as unknown as Parameters<typeof getObject>[0];
    const res = await getObject(client, 'bucket', 'key');
    expect(res).toBeNull();
  });

  it('rethrows non-NoSuchKey errors', async () => {
    const send = vi.fn(async () => {
      throw new Error('500');
    });
    const client = { send } as unknown as Parameters<typeof getObject>[0];
    await expect(getObject(client, 'bucket', 'key')).rejects.toThrow('500');
  });
});
