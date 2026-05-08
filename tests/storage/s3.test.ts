import { describe, expect, it } from 'vitest';
import { createS3Client } from '../../src/storage/s3.ts';

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
