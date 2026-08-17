import type { Readable } from 'node:stream';

/**
 * Object storage port.
 *
 * Deliberately narrow - put, exists, read, and a locator. Anything richer (ACLs,
 * lifecycle rules, presigned URLs with policies) would leak S3 concepts into
 * business logic and make the local driver a poor stand-in.
 */

export interface StoredObject {
  key: string;
  provider: 'local' | 's3';
  sizeBytes: number;
  contentType?: string;
}

export interface PutOptions {
  contentType?: string;
  /**
   * Passed through when known. S3 can stream without it, but supplying it avoids
   * multipart overhead on small objects.
   */
  contentLength?: number;
}

export interface Storage {
  readonly provider: 'local' | 's3';

  /**
   * Whether an object already exists at this key.
   *
   * Load-bearing rather than an optimisation: keys are content-addressed by
   * sha256, so a hit means these exact bytes are already stored - a repost of an
   * image we have. Skipping the upload is both a cost saving and how repost
   * detection stays cheap.
   */
  exists(key: string): Promise<boolean>;

  /** Streams the body to storage. Never buffers the whole object in memory. */
  putStream(key: string, body: Readable, options?: PutOptions): Promise<StoredObject>;

  getStream(key: string): Promise<Readable>;

  /**
   * A locator for the stored object - an s3:// URI or a local path.
   *
   * Not a publicly fetchable URL: the bucket is private, and serving media is
   * outside this pipeline's job. Presigning would be the extension point.
   */
  getLocator(key: string): string;
}

/**
 * Builds a content-addressed key with a two-level prefix, e.g.
 * `media/ab/cd/abcdef...jpg`.
 *
 * The prefix keeps directory fan-out manageable on the local driver - tens of
 * thousands of files in one folder makes listing painfully slow on Windows - and
 * spreads keys across S3 partitions.
 */
export function contentAddressedKey(sha256: string, extension: string): string {
  const a = sha256.slice(0, 2);
  const b = sha256.slice(2, 4);
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `media/${a}/${b}/${sha256}${ext}`;
}

/** Maps a content type onto a file extension, defaulting to .bin when unknown. */
export function extensionForContentType(contentType: string | undefined): string {
  if (!contentType) {
    return '.bin';
  }

  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };

  return map[normalized] ?? '.bin';
}
