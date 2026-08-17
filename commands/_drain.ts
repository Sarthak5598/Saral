import { MediaAssetService } from '../src/api/services/MediaAssetService';
import { componentLogger } from '../src/lib/logger';
import type { Queue } from '../src/ports/Queue';
import type { Storage } from '../src/ports/Storage';
import { JobType } from '../src/types/jobs';

const log = componentLogger('cmd:drain');

export interface DrainSummary {
  stored: number;
  deduplicated: number;
  skipped: number;
  failed: number;
}

/**
 * Runs the asset-download jobs a sync just enqueued, then returns.
 *
 * Exists so `pnpm sync:top matcha` demonstrates the whole path in one command -
 * nobody reviewing this will wait three hours for the scheduler, and under the
 * local driver the in-memory queue dies with the process anyway.
 *
 * The polling here is more careful than it looks, because of an SQS behaviour that
 * bites hard:
 *
 *   With WaitTimeSeconds=0, SQS *short polls* - it samples a subset of its servers
 *   and can return zero messages while the queue is demonstrably non-empty. A
 *   drain loop that stops on the first empty response therefore abandons work. That
 *   is exactly what happened on the first AWS run: 12 jobs were enqueued, the loop
 *   saw an empty poll after 11, and 4 messages were left sitting in the queue.
 *
 * So: long-poll, and require several consecutive empty responses before believing
 * the queue is actually empty.
 */
export async function drainAssetJobs(
  queue: Queue,
  storage: Storage,
  options: { emptyPollsBeforeStop?: number; waitTimeSeconds?: number } = {},
): Promise<DrainSummary> {
  const assetService = new MediaAssetService(storage);
  // Short polling needs more confirmations; long polling on the in-memory driver
  // is exact, so one is enough there.
  const emptyPollsBeforeStop =
    options.emptyPollsBeforeStop ?? (queue.provider === 'sqs' ? 3 : 1);
  const waitTimeSeconds = options.waitTimeSeconds ?? (queue.provider === 'sqs' ? 5 : 0);

  const summary: DrainSummary = { stored: 0, deduplicated: 0, skipped: 0, failed: 0 };
  let consecutiveEmpty = 0;

  while (consecutiveEmpty < emptyPollsBeforeStop) {
    const messages = await queue.receive({ maxMessages: 10, waitTimeSeconds });

    if (messages.length === 0) {
      consecutiveEmpty += 1;
      continue;
    }

    consecutiveEmpty = 0;

    for (const message of messages) {
      if (message.job.type !== JobType.DOWNLOAD_MEDIA_ASSET) {
        // Someone else's job - hand it back rather than dropping it.
        await queue.nack(message);
        continue;
      }

      try {
        const result = await assetService.download(message.job.mediaId);

        if (result.status === 'stored') {
          summary.stored += 1;
        } else if (result.status === 'deduplicated') {
          summary.deduplicated += 1;
        } else {
          summary.skipped += 1;
        }

        await queue.ack(message);
      } catch (error) {
        summary.failed += 1;
        log.error(
          { err: error, mediaId: message.job.mediaId },
          'asset download failed - acked so the drain finishes; the row is marked failed and retryable',
        );
        // Acked deliberately: this is an interactive command, not the worker. The
        // asset row records status='failed' with the error, so the work is
        // recoverable without leaving messages stuck in flight.
        await queue.ack(message);
      }
    }
  }

  return summary;
}
