import { buildHandlers } from './api/consumers/index';
import { closeAdapters, getQueue, getScheduler, getStorage } from './adapters/index';
import { checkDatabaseConnection, closeDatabase } from './database/client';
import { env } from './lib/env';
import { componentLogger } from './lib/logger';
import { JobRunner } from './worker/JobRunner';

const log = componentLogger('worker-main');

/**
 * Worker entrypoint.
 *
 * Runs the job loop and, under the local driver, the cron that feeds it. With
 * SCHEDULER_DRIVER=aws the cron half is a no-op because EventBridge fires
 * independently of this process - which is exactly why it is the better option.
 */
async function main(): Promise<void> {
  if (!(await checkDatabaseConnection())) {
    throw new Error('cannot reach Postgres - check DATABASE_URL and that Docker is up');
  }

  const queue = getQueue();
  const storage = getStorage();
  const scheduler = getScheduler();

  await scheduler.ensureSchedules();
  await scheduler.start();

  const runner = new JobRunner({
    queue,
    handlers: buildHandlers({ queue, storage }),
    // Kept low deliberately: a sync is dominated by waiting on Meta, and running
    // many concurrently would burn the shared rate-limit budget faster without
    // finishing sooner.
    maxConcurrent: env.DOWNLOAD_CONCURRENCY,
    waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
    visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT,
  });

  log.info(
    {
      drivers: {
        queue: queue.provider,
        storage: storage.provider,
        scheduler: scheduler.provider,
      },
      cron: scheduler.provider === 'node-cron' ? env.RECENT_SYNC_CRON : '(owned by EventBridge)',
    },
    'worker booting',
  );

  let shuttingDown = false;

  /**
   * Graceful shutdown matters more here than for the API.
   *
   * A hard kill mid-sync leaves the SQS message in flight until its visibility
   * timeout expires, delaying the retry by minutes. Stopping cleanly lets the
   * current job finish and ack, and the resumable cursor covers whatever does not.
   */
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log.info({ signal }, 'shutdown requested, draining in-flight jobs');

    const forced = setTimeout(() => {
      log.error('graceful shutdown timed out after 30s, forcing exit');
      process.exit(1);
    }, 30_000);
    forced.unref();

    try {
      await runner.stop();
      await closeAdapters();
      await closeDatabase();
      clearTimeout(forced);
      log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await runner.start();
}

main().catch((error) => {
  log.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
