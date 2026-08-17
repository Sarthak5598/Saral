import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { componentLogger } from '../../lib/logger';
import type { PutOptions, Storage, StoredObject } from '../../ports/Storage';

const log = componentLogger('storage:local');

/**
 * Local filesystem storage - the default driver, and the one tests use.
 *
 * Keys are treated as POSIX-style paths and joined under a root directory, so the
 * same key works identically here and as an S3 object key. That symmetry is what
 * lets the driver be swapped without touching the database: `storage_key` is
 * provider-independent.
 */
export class LocalDiskStorage implements Storage {
  readonly provider = 'local' as const;

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    // Reject traversal. Keys are derived from sha256 hashes today, but this is a
    // filesystem write driven by data that ultimately came off the network.
    const normalized = path.posix.normalize(key);
    if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
      throw new Error(`unsafe storage key: ${key}`);
    }
    return path.join(this.root, ...normalized.split('/'));
  }

  async exists(key: string): Promise<boolean> {
    try {
      const info = await stat(this.resolve(key));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async putStream(key: string, body: Readable, options?: PutOptions): Promise<StoredObject> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });

    // Write to a temp file and rename, so a crash mid-write cannot leave a
    // truncated file sitting at a content-addressed key - which would then look
    // valid to `exists()` forever.
    const temp = `${target}.${process.pid}.partial`;

    try {
      await pipeline(body, createWriteStream(temp));
      const { rename } = await import('node:fs/promises');
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }

    const info = await stat(target);
    log.debug({ key, sizeBytes: info.size }, 'stored object');

    return {
      key,
      provider: this.provider,
      sizeBytes: info.size,
      contentType: options?.contentType,
    };
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  getLocator(key: string): string {
    return this.resolve(key);
  }
}
