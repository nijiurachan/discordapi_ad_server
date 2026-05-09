import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
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

export type S3GetObjectResult = {
  body: ReadableStream;
  contentType: string | undefined;
  contentLength: number | undefined;
  etag: string | undefined;
};

/**
 * Fetch an object from S3. Returns null on 404; throws on other errors.
 */
export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<S3GetObjectResult | null> {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) return null;
    // res.Body is a Readable in Node, ReadableStream in Workers. The SDK's
    // ReadableStream type is the Web stream when running on Workers.
    return {
      body: res.Body as unknown as ReadableStream,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      etag: res.ETag,
    };
  } catch (err) {
    if (err && typeof err === 'object') {
      const e = err as {
        name?: string;
        Code?: string;
        $metadata?: { httpStatusCode?: number };
      };
      // NoSuchKey is the canonical "object missing" signal across AWS SDK and
      // most S3-compatible backends. Treat as null.
      if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') {
        return null;
      }
      // Bare HTTP 404 *without* a specific error name (some S3-compatible
      // implementations like MinIO) — treat as null only when no named error
      // code is set, so we don't mask NoSuchBucket / AccessDenied / etc.
      // The default `new Error()` name is 'Error' (i.e., not a specific S3
      // error), so we accept that as "unspecified".
      if (e.$metadata?.httpStatusCode === 404 && (!e.name || e.name === 'Error') && !e.Code) {
        return null;
      }
    }
    throw err;
  }
}
