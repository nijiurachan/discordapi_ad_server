import { S3Client } from '@aws-sdk/client-s3';

export type S3Config = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function createS3Client(cfg: S3Config): S3Client {
  if (!cfg.endpoint) throw new Error('S3 endpoint is required');
  if (!cfg.region) throw new Error('S3 region is required');
  if (!cfg.accessKeyId) throw new Error('S3 accessKeyId is required');
  if (!cfg.secretAccessKey) throw new Error('S3 secretAccessKey is required');
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}
