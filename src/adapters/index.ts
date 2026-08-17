import path from 'node:path';

import { env } from '../lib/env';
import { componentLogger } from '../lib/logger';
import type { Queue } from '../ports/Queue';
import type { Scheduler } from '../ports/Scheduler';
import type { Storage } from '../ports/Storage';
import { EventBridgeScheduler } from './aws/EventBridgeScheduler';
import { S3Storage } from './aws/S3Storage';
import { SqsQueue } from './aws/SqsQueue';
import { InMemoryQueue } from './local/InMemoryQueue';
import { LocalDiskStorage } from './local/LocalDiskStorage';
import { NodeCronScheduler } from './local/NodeCronScheduler';

const log = componentLogger('adapters');

/**
 * The single place where a driver is chosen.
 *
 * Everything else in the codebase depends on the Queue / Storage / Scheduler
 * interfaces, so moving from local to AWS is three environment variables and no
 * code change. The three are independent on purpose: S3 storage with an in-memory
 * queue is a valid intermediate state during a migration.
 *
 * Instances are memoised because the API process and the worker each want one
 * client, not one per call site.
 */

let queueInstance: Queue | undefined;
let storageInstance: Storage | undefined;
let schedulerInstance: Scheduler | undefined;

export function getQueue(): Queue {
  if (queueInstance) {
    return queueInstance;
  }

  if (env.QUEUE_DRIVER === 'aws') {
    // Non-null assertion is safe: lib/env refuses to boot with QUEUE_DRIVER=aws
    // and no SQS_QUEUE_URL.
    queueInstance = new SqsQueue(
      env.SQS_QUEUE_URL!,
      env.AWS_REGION,
      env.SQS_WAIT_TIME_SECONDS,
    );
  } else {
    queueInstance = new InMemoryQueue(env.SQS_VISIBILITY_TIMEOUT * 1000, 3);
  }

  log.info({ driver: queueInstance.provider }, 'queue driver selected');
  return queueInstance;
}

export function getStorage(): Storage {
  if (storageInstance) {
    return storageInstance;
  }

  if (env.STORAGE_DRIVER === 'aws') {
    storageInstance = new S3Storage(env.S3_BUCKET!, env.AWS_REGION);
  } else {
    storageInstance = new LocalDiskStorage(path.resolve(env.LOCAL_STORAGE_DIR));
  }

  log.info({ driver: storageInstance.provider }, 'storage driver selected');
  return storageInstance;
}

export function getScheduler(): Scheduler {
  if (schedulerInstance) {
    return schedulerInstance;
  }

  if (env.SCHEDULER_DRIVER === 'aws') {
    if (!env.EVENTBRIDGE_SCHEDULE_ROLE_ARN) {
      throw new Error(
        'EVENTBRIDGE_SCHEDULE_ROLE_ARN is required when SCHEDULER_DRIVER=aws - ' +
          'EventBridge needs a role it can assume to call sqs:SendMessage. ' +
          'Run `pnpm aws:provision` to create it.',
      );
    }

    schedulerInstance = new EventBridgeScheduler({
      scheduleName: env.EVENTBRIDGE_SCHEDULE_NAME,
      // node-cron's 5-field syntax is not EventBridge's 6-field syntax, so it is
      // translated rather than passed through.
      scheduleExpression: toEventBridgeExpression(env.RECENT_SYNC_CRON),
      queueUrl: env.SQS_QUEUE_URL!,
      roleArn: env.EVENTBRIDGE_SCHEDULE_ROLE_ARN,
      region: env.AWS_REGION,
    });
  } else {
    schedulerInstance = new NodeCronScheduler(getQueue(), env.RECENT_SYNC_CRON);
  }

  log.info({ driver: schedulerInstance.provider }, 'scheduler driver selected');
  return schedulerInstance;
}

/**
 * Converts a 5-field cron expression to EventBridge's 6-field form.
 *
 * EventBridge requires `cron(minute hour day-of-month month day-of-week year)`
 * and, unlike standard cron, forbids specifying both day-of-month and day-of-week
 * - one must be `?`. Passing a Unix expression straight through is a common way to
 * get a schedule that silently never fires.
 */
export function toEventBridgeExpression(unixCron: string): string {
  const fields = unixCron.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      `expected a 5-field cron expression, got ${fields.length} fields: "${unixCron}"`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Exactly one of day-of-month / day-of-week must be '?'.
  const dom = dayOfMonth === '*' && dayOfWeek !== '*' ? '?' : dayOfMonth;
  const dow = dayOfWeek === '*' && dom !== '?' ? '?' : dayOfWeek;

  return `cron(${minute} ${hour} ${dom} ${month} ${dow} *)`;
}

/** Releases driver resources. Used by graceful shutdown and by tests. */
export async function closeAdapters(): Promise<void> {
  await schedulerInstance?.stop().catch(() => undefined);
  await queueInstance?.close().catch(() => undefined);
  queueInstance = undefined;
  storageInstance = undefined;
  schedulerInstance = undefined;
}

/** Test seam: lets a suite inject fakes without touching env. */
export function __setAdaptersForTest(overrides: {
  queue?: Queue;
  storage?: Storage;
  scheduler?: Scheduler;
}): void {
  if (overrides.queue) {
    queueInstance = overrides.queue;
  }
  if (overrides.storage) {
    storageInstance = overrides.storage;
  }
  if (overrides.scheduler) {
    schedulerInstance = overrides.scheduler;
  }
}
