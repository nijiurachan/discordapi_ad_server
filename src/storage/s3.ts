import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

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

export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array | ArrayBuffer | string,
  contentType: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body instanceof ArrayBuffer ? new Uint8Array(body) : body,
      ContentType: contentType,
    }),
  );
}

export async function copyObject(
  client: S3Client,
  bucket: string,
  sourceKey: string,
  destKey: string,
): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      // The AWS SDK requires CopySource to be URL-encoded. Our keys are
      // UUID-based and safe today, but encoding defensively means future
      // changes to key shape (e.g., user-provided slugs) won't silently
      // break. encodeURIComponent percent-encodes "/" as "%2F", which the
      // SDK accepts.
      CopySource: encodeURIComponent(`${bucket}/${sourceKey}`),
      Key: destKey,
    }),
  );
}

export async function deleteObject(client: S3Client, bucket: string, key: string): Promise<void> {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
}
