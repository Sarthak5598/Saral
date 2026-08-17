import { componentLogger } from '../../lib/logger';
import type { Queue } from '../../ports/Queue';
import type { Storage } from '../../ports/Storage';
import { JobType, type Job, type JobType as JobTypeName } from '../../types/jobs';
import type { JobContext, JobHandler } from '../../worker/JobRunner';
import { UnprocessableJobError } from '../../worker/JobRunner';
import * as HashtagRepository from '../repositories/HashtagRepository';
import { HashtagSyncService } from '../services/HashtagSyncService';
import { MediaAssetService } from '../services/MediaAssetService';

const log = componentLogger('consumers');

/**
 * Builds the job-type -> handler map the worker dispatches on.
 *
 * Dependencies are passed in rather than imported as singletons so a test can run
 * a real consumer against a fake queue and an in-memory storage driver.
 */
export function buildHandlers(deps: {
  queue: Queue;
  storage: Storage;
}): Partial<Record<JobTypeName, JobHandler>> {
  const syncService = new HashtagSyncService(deps.queue);
  const assetService = new MediaAssetService(deps.storage);

  /**
   * Fan-out dispatcher.
   *
   * This is the only job EventBridge sends, and it names no hashtag - a schedule
   * cannot query the database. Resolving the due hashtags here is what makes
   * tracking a new tag a row insert rather than an AWS reconfiguration.
   */
  const dispatchDueSyncs: JobHandler = async (job: Job) => {
    if (job.type !== JobType.DISPATCH_DUE_SYNCS) {
      return;
    }

    const due = await HashtagRepository.findDueForSync(job.kind);

    if (due.length === 0) {
      log.warn({ kind: job.kind }, 'no hashtags are due for sync');
      return;
    }

    const jobs: Job[] = due.map((hashtag) =>
      job.kind === 'top'
        ? { type: JobType.SYNC_TOP_HASHTAG_MEDIA, hashtagId: hashtag.id }
        : { type: JobType.SYNC_RECENT_HASHTAG_MEDIA, hashtagId: hashtag.id },
    );

    await deps.queue.enqueueBatch(jobs);

    log.info(
      { kind: job.kind, count: jobs.length, hashtags: due.map((h) => h.name) },
      'dispatched sync jobs',
    );
  };

  const syncMedia: JobHandler = async (job: Job, context: JobContext) => {
    if (
      job.type !== JobType.SYNC_TOP_HASHTAG_MEDIA &&
      job.type !== JobType.SYNC_RECENT_HASHTAG_MEDIA
    ) {
      return;
    }

    const kind = job.type === JobType.SYNC_TOP_HASHTAG_MEDIA ? 'top' : 'recent';

    const hashtag = await HashtagRepository.findById(job.hashtagId);
    if (!hashtag) {
      // A deleted hashtag will not reappear, so retrying is pointless.
      throw new UnprocessableJobError(`hashtag ${job.hashtagId} no longer exists`);
    }

    await syncService.sync({
      hashtagId: job.hashtagId,
      kind,
      messageId: context.messageId,
      attempt: context.attempt,
      signal: context.signal,
    });
  };

  const downloadAsset: JobHandler = async (job: Job, context: JobContext) => {
    if (job.type !== JobType.DOWNLOAD_MEDIA_ASSET) {
      return;
    }

    await assetService.download(job.mediaId, context.signal);
  };

  return {
    [JobType.DISPATCH_DUE_SYNCS]: dispatchDueSyncs,
    [JobType.SYNC_TOP_HASHTAG_MEDIA]: syncMedia,
    [JobType.SYNC_RECENT_HASHTAG_MEDIA]: syncMedia,
    [JobType.DOWNLOAD_MEDIA_ASSET]: downloadAsset,
  };
}
