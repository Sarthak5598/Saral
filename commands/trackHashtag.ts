import { getQueue } from '../src/adapters/index';
import { ensureTracked, setIgHashtagId } from '../src/api/repositories/HashtagRepository';
import { metaClient } from '../src/lib/meta/MetaGraphClient';
import { componentLogger } from '../src/lib/logger';
import { JobType } from '../src/types/jobs';
import { optionalArg, requireArg, runCommand } from './_runner';

const log = componentLogger('cmd:hashtag:track');

/**
 * Starts tracking a hashtag.
 *
 *   pnpm hashtag:track matcha
 *   pnpm hashtag:track coffee 2026-09-01 2026-09-30
 *
 * Resolves Meta's hashtag ID, stores the row, and enqueues an immediate top-media
 * sync so the tag is useful straight away rather than after the next 3-hour tick.
 *
 * A CLI command rather than a POST endpoint on purpose: the brief specifies one
 * paginated API, and adding write endpoints past that reads as not having read it.
 *
 * Worth knowing before adding tags in bulk: Meta allows 30 *unique* hashtags per
 * rolling 7 days per IG account. Re-syncing an already-queried tag is free within
 * that window, but the 31st new tag in a week will fail.
 */
runCommand('hashtag:track', async () => {
  const name = requireArg(0, 'pnpm hashtag:track <name> [trackFrom] [trackUntil]');
  const trackFrom = optionalArg(1);
  const trackUntil = optionalArg(2);

  const hashtag = await ensureTracked({
    name,
    trackFrom: trackFrom ? new Date(trackFrom) : null,
    trackUntil: trackUntil ? new Date(trackUntil) : null,
  });

  let igHashtagId = hashtag.igHashtagId;

  if (!igHashtagId) {
    igHashtagId = await metaClient.resolveHashtagId(hashtag.name);
    await setIgHashtagId(hashtag.id, igHashtagId);
  } else {
    log.info({ igHashtagId }, 'reusing cached hashtag id (saves Meta quota)');
  }

  const queue = getQueue();
  const messageId = await queue.enqueue({
    type: JobType.SYNC_TOP_HASHTAG_MEDIA,
    hashtagId: hashtag.id,
  });

  log.info(
    {
      hashtag: hashtag.name,
      id: hashtag.id,
      igHashtagId,
      trackFrom: hashtag.trackFrom,
      trackUntil: hashtag.trackUntil,
      enqueuedMessageId: messageId,
    },
    'hashtag tracked and initial top-media sync enqueued',
  );

  if (queue.provider === 'local') {
    log.warn(
      'QUEUE_DRIVER=local means this job lives in memory and dies with this process - ' +
        'run `pnpm sync:top ' +
        hashtag.name +
        '` to execute it inline instead',
    );
  }
});
