import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

// Mock the AWS SDK signer module before importing the helper.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/foo?sig=abc'),
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { presignGetUrl } from '../../src/storage/s3-presign.ts';

describe('presignGetUrl', () => {
  it('calls getSignedUrl with a GetObjectCommand and TTL, returns string', async () => {
    const s3 = { send: vi.fn() } as unknown as S3Client;
    const url = await presignGetUrl(s3, 'bucket', 'key/x.png', 600);
    expect(url).toBe('https://signed.example/foo?sig=abc');
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const call = (getSignedUrl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      S3Client,
      { input: { Bucket: string; Key: string } },
      { expiresIn: number },
    ];
    expect(call[0]).toBe(s3);
    expect(call[1].input.Bucket).toBe('bucket');
    expect(call[1].input.Key).toBe('key/x.png');
    expect(call[2].expiresIn).toBe(600);
  });

  it('defaults TTL to 300 seconds when omitted', async () => {
    const s3 = { send: vi.fn() } as unknown as S3Client;
    await presignGetUrl(s3, 'bucket', 'key.png');
    const call = (getSignedUrl as unknown as { mock: { calls: unknown[][] } }).mock.calls.pop() as [
      S3Client,
      unknown,
      { expiresIn: number },
    ];
    expect(call[2].expiresIn).toBe(300);
  });
});
