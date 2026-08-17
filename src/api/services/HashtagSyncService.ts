import { MetaAuthError } from '../errors/ApiError';
import { syncLockKey, withAdvisoryLock } from '../../database/advisoryLock';
import { env } from '../../lib/env';
import { componentLogger } from '../../lib/logger';
import { metaClient, type MetaGraphClient } from '../../lib/meta/MetaGraphClient';
import type { Queue } from '../../ports/Queue';
import { JobType } from '../../types/jobs';
import * as HashtagRepository from '../repositories/HashtagRepository';
import * as MediaAssetRepository from '../repositories/MediaAssetRepository';
import * as MediaRepository from '../repositories/MediaRepository';
import * as RawPayloadRepository from '../repositories/RawPayloadRepository';
import * as SyncRunRepository from '../repositories/SyncRunRepository';

const log = componentLogger('sync-service');

export interface SyncOptions {
  hashtagId: string;
  kind: 'top' | 'recent';
  messageId?: string;
  attempt?: number;
  signal?: AbortSignal;
}

export interface SyncOutcome {
  skipped: boolean;
  syncRunId?: string;
  itemsSeen: number;
  itemsNew: number;
  assetJobsEnqueued: number;
}

const JOB_TYPE_FOR_KIND = {
  top: JobType.SYNC_TOP_HASHTAG_MEDIA,
  recent: JobType.SYNC_RECENT_HASHTAG_MEDIA,
} as const;

/**
 * Ingests one hashtag's media from one Meta edge.
 *
 * The ordering inside the page loop is the important part:
 *
 *   1. write the raw payload
 *   2. upsert the curated row + metric snapshot + caption entities
 *   3. create the pending asset row and enqueue its download
 *   4. record the cursor
 *
 * Raw comes first so that even if parsing blows up on an unexpected shape, the
 * response is preserved and `pnpm replay` can rebuild from it without spending
 * API quota. The cursor is recorded last, per page, so a crash resumes from the
 * last fully-persisted page rather than restarting - at ~8s per page that is the
 * difference between losing seconds and losing ten minutes plus quota.
 */
export class HashtagSyncService {
  constructor(
    private readonly queue: Queue,
    private readonly client: MetaGraphClient = metaClient,
  ) {}

  async sync(options: SyncOptions): Promise<SyncOutcome> {
    const { hashtagId, kind } = options;

    /**
     * Serialised per hashtag+kind. Concurrent syncs are not corrupting - the
     * upserts are idempotent - but they double consumption of a quota capped at 30
     * unique hashtags per 7 days, so they are worth preventing. Non-blocking: if
     * another run holds the lock we skip and let the next schedule handle it,
     * rather than tying up a worker slot for 11 minutes.
     */
    const locked = await withAdvisoryLock(syncLockKey(hashtagId, kind), () =>
      this.runSync(options),
    );

    if (!locked.acquired) {
      log.info({ hashtagId, kind }, 'another sync is already running for this hashtag, skipping');
      return { skipped: true, itemsSeen: 0, itemsNew: 0, assetJobsEnqueued: 0 };
    }

    return locked.result;
  }

  private async runSync(options: SyncOptions): Promise<SyncOutcome> {
    const { hashtagId, kind } = options;
    const jobType = JOB_TYPE_FOR_KIND[kind];

    const hashtag = await HashtagRepository.findById(hashtagId);
    if (!hashtag) {
      throw new Error(`hashtag ${hashtagId} not found`);
    }

    // Resolve Meta's hashtag ID once and cache it. This is quota control: only
    // *unique* hashtags count against the 30-per-7-days allowance, so re-resolving
    // is the one operation that can permanently wedge the pipeline.
    let igHashtagId = hashtag.igHashtagId;
    if (!igHashtagId) {
      igHashtagId = await this.client.resolveHashtagId(hashtag.name, options.signal);
      await HashtagRepository.setIgHashtagId(hashtag.id, igHashtagId);
    }

    // Resume an interrupted run rather than starting a fresh one.
    const resumable = await SyncRunRepository.findResumableRun(jobType, hashtagId);
    const run =
      resumable ??
      (await SyncRunRepository.startRun({
        type: jobType,
        hashtagId,
        messageId: options.messageId,
        attempt: options.attempt,
      }));

    if (resumable) {
      log.warn(
        {
          syncRunId: run.id,
          pagesAlreadyFetched: run.pagesFetched,
          itemsAlreadySeen: run.itemsSeen,
        },
        'resuming interrupted sync run',
      );
    }

    const runLog = log.child({ syncRunId: run.id, hashtag: hashtag.name, kind });
    const maxItems = hashtag.maxMediaPerSync ?? env.SYNC_MAX_MEDIA_PER_RUN;

    let itemsSeen = run.itemsSeen;
    let itemsNew = 0;
    let assetJobsEnqueued = 0;
    let hitItemCap = false;

    try {
      for await (const page of this.client.paginateMedia({
        hashtagId: igHashtagId,
        edge: kind === 'top' ? 'top_media' : 'recent_media',
        maxItems: maxItems - itemsSeen,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(run.lastCursor ? { startCursor: run.lastCursor } : {}),
      })) {
        // 1. Raw first: preserve the response before trusting our own parsing.
        await RawPayloadRepository.recordPage({
          syncRunId: run.id,
          hashtagId,
          source: kind,
          pageNumber: page.pageNumber,
          offset: itemsSeen,
          items: page.items,
        });

        let pageNew = 0;
        let pageUpdated = 0;
        let pageAssetJobs = 0;

        // 2. Curated, one item at a time so a single malformed item cannot lose
        //    the whole page.
        for (const [index, item] of page.items.entries()) {
          const result = await MediaRepository.upsertMedia({
            media: item,
            hashtagId,
            syncRunId: run.id,
            source: kind,
            rank: itemsSeen + index + 1,
          });

          if (result.isNew) {
            pageNew += 1;
          }
          if (result.contentChanged) {
            pageUpdated += 1;
          }

          // 3. One download job per asset, not one per sync. A 404 video must fail
          //    alone, and downloads are far slower than metadata writes.
          const asset = await MediaAssetRepository.ensurePending(
            result.id,
            item.media_url ?? null,
          );

          if (asset.created && item.media_url) {
            await this.queue.enqueue({
              type: JobType.DOWNLOAD_MEDIA_ASSET,
              mediaId: result.id,
            });
            pageAssetJobs += 1;
          }
        }

        itemsSeen += page.items.length;
        itemsNew += pageNew;
        assetJobsEnqueued += pageAssetJobs;

        // 4. Cursor last: only advance past a page that is fully persisted.
        await SyncRunRepository.recordPageProgress(run.id, {
          itemsSeen: page.items.length,
          itemsNew: pageNew,
          itemsUpdated: pageUpdated,
          assetJobsEnqueued: pageAssetJobs,
          lastCursor: page.nextCursor,
          rateLimit: page.rateLimit,
        });

        runLog.info(
          {
            page: page.pageNumber,
            items: page.items.length,
            new: pageNew,
            updated: pageUpdated,
            totalSeen: itemsSeen,
            usagePct: page.rateLimit?.worstPct,
          },
          'page persisted',
        );

        if (itemsSeen >= maxItems) {
          // Recorded explicitly: a truncated run is otherwise indistinguishable
          // from a complete one, which would misrepresent coverage.
          hitItemCap = true;
          runLog.info({ maxItems }, 'reached item cap, stopping');
          break;
        }
      }

      await SyncRunRepository.finishRun(run.id, { status: 'succeeded', hitItemCap });
      await HashtagRepository.markSyncSucceeded(hashtagId, kind);

      runLog.info({ itemsSeen, itemsNew, assetJobsEnqueued }, 'sync completed');
      return { skipped: false, syncRunId: run.id, itemsSeen, itemsNew, assetJobsEnqueued };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      /**
       * Partial, not failed, when some pages landed. The distinction is real: 40
       * pages of data were persisted and are queryable, and the run is resumable
       * from its cursor. Recording it as an outright failure would understate what
       * was collected.
       */
      const status = itemsSeen > run.itemsSeen ? 'partial' : 'failed';
      await SyncRunRepository.finishRun(run.id, { status, error: message, hitItemCap });
      await HashtagRepository.markSyncFailed(hashtagId, message);

      if (error instanceof MetaAuthError) {
        // Escalated above a normal failure. An expired token makes every sync
        // return nothing, which reads exactly like "no new posts" unless it is
        // shouted about.
        runLog.fatal(
          { err: error },
          'Meta rejected the access token - every sync will return nothing until META_ACCESS_TOKEN is refreshed',
        );
      } else {
        runLog.error({ err: error, itemsSeen, status }, 'sync failed');
      }

      throw error;
    }
  }
}
