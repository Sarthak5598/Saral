import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { env } from '../../lib/env';
import { componentLogger } from '../../lib/logger';
import type { Storage } from '../../ports/Storage';
import { contentAddressedKey, extensionForContentType } from '../../ports/Storage';
import { UnprocessableJobError } from '../../worker/JobRunner';
import * as MediaAssetRepository from '../repositories/MediaAssetRepository';
import * as MediaRepository from '../repositories/MediaRepository';

const log = componentLogger('asset-service');

export interface DownloadResult {
  status: 'stored' | 'deduplicated' | 'skipped';
  sha256?: string;
  storageKey?: string;
  sizeBytes?: number;
}

/**
 * Downloads a media file from Meta's CDN and stores it durably.
 *
 * This exists because Meta's `media_url` is a signed CDN link that expires within
 * days. Storing only the URL produces a system that works today and serves broken
 * images next week. `permalink` is stable; `media_url` is not.
 */
export class MediaAssetService {
  constructor(private readonly storage: Storage) {}

  async download(mediaId: string, signal?: AbortSignal): Promise<DownloadResult> {
    const media = await MediaRepository.findById(mediaId);

    if (!media) {
      // The row is gone. Retrying cannot bring it back, so this must not cycle
      // through the queue until it hits the DLQ.
      throw new UnprocessableJobError(`media ${mediaId} no longer exists`);
    }

    const asset = await MediaAssetRepository.findByMediaId(mediaId);

    if (asset?.status === 'stored') {
      // Already have the bytes. Redelivery of the job is expected under
      // at-least-once semantics, so this is a normal path, not an anomaly.
      log.debug({ mediaId, key: asset.storageKey }, 'asset already stored, nothing to do');
      return { status: 'skipped' };
    }

    const sourceUrl = asset?.fetchedFromUrl ?? media.sourceMediaUrl;

    if (!sourceUrl) {
      await MediaAssetRepository.markSkipped(mediaId, 'no media_url provided by Meta');
      return { status: 'skipped' };
    }

    await MediaAssetRepository.markDownloading(mediaId);

    // Staged through a temp file rather than buffered.
    //
    // The key is the sha256 of the content, so the hash has to be known before the
    // final key exists - and a video cannot be held in memory to hash it. Writing
    // to a temp file while hashing keeps memory flat regardless of file size, at
    // the cost of one extra local write.
    const workDir = await mkdtemp(path.join(tmpdir(), 'hmp-asset-'));
    const tempFile = path.join(workDir, 'download');

    try {
      const response = await fetch(sourceUrl, {
        signal: signal ?? AbortSignal.timeout(env.META_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        // 403/404 here usually means the signed URL expired rather than that the
        // media is gone. The next sync refreshes media_url, so a retry can
        // legitimately succeed later - hence a normal error, not Unprocessable.
        throw new Error(
          `CDN returned HTTP ${response.status} for media ${mediaId} ` +
            `(a signed media_url that has expired is the usual cause)`,
        );
      }

      if (!response.body) {
        throw new Error(`CDN response for media ${mediaId} had no body`);
      }

      const hash = createHash('sha256');
      let sizeBytes = 0;

      const source = Readable.fromWeb(response.body as never);
      source.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        sizeBytes += chunk.length;
      });

      await pipeline(source, createWriteStream(tempFile));

      const sha256 = hash.digest('hex');
      const contentType = response.headers.get('content-type') ?? undefined;
      const key = contentAddressedKey(sha256, extensionForContentType(contentType));

      // Verify against the filesystem rather than trusting the counter.
      const onDisk = await stat(tempFile);
      if (onDisk.size !== sizeBytes) {
        throw new Error(
          `size mismatch for media ${mediaId}: counted ${sizeBytes}, wrote ${onDisk.size}`,
        );
      }

      /**
       * Content addressing pays off here.
       *
       * Two different Instagram posts can be byte-identical - reposts are common
       * on a tag like #matcha - so the key may already exist. When it does, the
       * upload is skipped entirely and both media rows point at the same object.
       * That saves storage and makes reposts queryable: several media rows sharing
       * one sha256 is a repost cluster.
       */
      if (await this.storage.exists(key)) {
        await MediaAssetRepository.markStored(mediaId, {
          sha256,
          storageKey: key,
          storageProvider: this.storage.provider,
          contentType,
          sizeBytes: onDisk.size,
        });

        log.info(
          { mediaId, sha256: sha256.slice(0, 12), key },
          'identical bytes already stored, skipped upload (repost)',
        );
        return { status: 'deduplicated', sha256, storageKey: key, sizeBytes: onDisk.size };
      }

      const stored = await this.storage.putStream(key, createReadStream(tempFile), {
        ...(contentType ? { contentType } : {}),
        contentLength: onDisk.size,
      });

      await MediaAssetRepository.markStored(mediaId, {
        sha256,
        storageKey: stored.key,
        storageProvider: stored.provider,
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
      });

      log.info(
        {
          mediaId,
          sha256: sha256.slice(0, 12),
          key: stored.key,
          sizeBytes: stored.sizeBytes,
          provider: stored.provider,
        },
        'asset stored',
      );

      return {
        status: 'stored',
        sha256,
        storageKey: stored.key,
        sizeBytes: stored.sizeBytes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await MediaAssetRepository.markFailed(mediaId, message);
      throw error;
    } finally {
      // Always clean up, including on failure - otherwise a few hundred failed
      // video downloads quietly fill the temp directory.
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
