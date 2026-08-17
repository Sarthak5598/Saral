import { getQueue, getStorage } from '../src/adapters/index';
import { findByName, findDueForSync } from '../src/api/repositories/HashtagRepository';
import { HashtagSyncService } from '../src/api/services/HashtagSyncService';
import { componentLogger } from '../src/lib/logger';
import { drainAssetJobs } from './_drain';
import { optionalArg, runCommand } from './_runner';

const log = componentLogger('cmd:sync:recent');

/**
 * Runs a recent-media sync inline.
 *
 *   pnpm sync:recent            # every hashtag currently due
 *   pnpm sync:recent matcha     # just this one
 *
 * With no argument it uses the same `findDueForSync` query the scheduled job uses,
 * so running it by hand exercises the path the 3-hour cron takes rather than a
 * parallel one that might drift from it.
 */
runCommand('sync:recent', async () => {
  const name = optionalArg(0);
  const queue = getQueue();
  const storage = getStorage();

  const hashtags = name
    ? [await findByName(name)].filter((value): value is NonNullable<typeof value> => Boolean(value))
    : await findDueForSync('recent');

  if (hashtags.length === 0) {
    throw new Error(
      name
        ? `hashtag "${name}" is not tracked - run: pnpm hashtag:track ${name}`
        : 'no hashtags are due for a recent sync',
    );
  }

  const syncService = new HashtagSyncService(queue);

  for (const hashtag of hashtags) {
    const outcome = await syncService.sync({ hashtagId: hashtag.id, kind: 'recent' });
    log.info({ hashtag: hashtag.name, ...outcome }, 'sync finished');
  }

  const summary = await drainAssetJobs(queue, storage);
  log.info({ ...summary, storageProvider: storage.provider }, 'asset downloads drained');
});
