import type { Readable } from 'node:stream';

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { componentLogger } from '../../lib/logger';
import type { PutOptions, Storage, StoredObject } from '../../ports/Storage';

const log = componentLogger('storage:s3');

/**
 * S3 storage driver.
 *
 * Uses lib-storage's `Upload` rather than PutObjectCommand because it accepts a
 * stream without knowing the length up front and switches to multipart for large
 * objects. That matters for video: PutObject would require buffering the whole
 * file to compute Content-Length, which defeats the point of streaming.
 */
export class S3Storage implements Storage {
  readonly provider = 's3' as const;

  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({ region });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      // 404/NotFound means absent. Anything else - permissions, throttling - is a
      // real failure and must not be reported as "does not exist", or the caller
      // would re-upload on every run and mask the problem.
      const name = (error as { name?: string })?.name;
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;

      if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) {
        return false;
      }
      throw error;
    }
  }

  async putStream(key: string, body: Readable, options?: PutOptions): Promise<StoredObject> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(options?.contentType ? { ContentType: options.contentType } : {}),
      },
      // 5MB is the S3 minimum part size; 4 concurrent parts is a reasonable
      // balance against the per-asset download concurrency already in play.
      partSize: 5 * 1024 * 1024,
      queueSize: 4,
    });

    await upload.done();

    // Trust the object store over the local byte count: HEAD reports what S3
    // actually persisted.
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    log.debug({ key, sizeBytes: head.ContentLength }, 'stored object');

    return {
      key,
      provider: this.provider,
      sizeBytes: head.ContentLength ?? 0,
      contentType: head.ContentType ?? options?.contentType,
    };
  }

  async getStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!result.Body) {
      throw new Error(`S3 object ${key} has no body`);
    }

    return result.Body as Readable;
  }

  /**
   * An s3:// URI, not an HTTPS URL. The bucket is private, so a plain URL would
   * be misleading - anyone needing browser access should presign, which is
   * deliberately out of scope here.
   */
  getLocator(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }
}
