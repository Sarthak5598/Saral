import { getQueue, getStorage } from '../src/adapters/index';
import { findByName } from '../src/api/repositories/HashtagRepository';
import { HashtagSyncService } from '../src/api/services/HashtagSyncService';
import { componentLogger } from '../src/lib/logger';
import { drainAssetJobs } from './_drain';
import { requireArg, runCommand } from './_runner';

const log = componentLogger('cmd:sync:top');

/**
 * Runs a top-media sync inline, then drains the asset downloads it queued.
 *
 *   pnpm sync:top matcha
 *
 * This is how the pipeline gets demonstrated: nobody reviewing the project will
 * wait three hours for the scheduler to fire, so the whole path has to be runnable
 * in one command. Inline rather than enqueue-and-wait so failures surface directly
 * in the terminal.
 */
runCommand('sync:top', async () => {
  const name = requireArg(0, 'pnpm sync:top <hashtag>');

  const hashtag = await findByName(name);
  if (!hashtag) {
    throw new Error(`hashtag "${name}" is not tracked - run: pnpm hashtag:track ${name}`);
  }

  const queue = getQueue();
  const storage = getStorage();

  const outcome = await new HashtagSyncService(queue).sync({
    hashtagId: hashtag.id,
    kind: 'top',
  });

  log.info(outcome, 'sync finished');

  const summary = await drainAssetJobs(queue, storage);
  log.info({ ...summary, storageProvider: storage.provider }, 'asset downloads drained');
});
