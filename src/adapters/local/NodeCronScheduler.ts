import cron, { type ScheduledTask } from 'node-cron';

import { componentLogger } from '../../lib/logger';
import type { Queue } from '../../ports/Queue';
import type { Scheduler } from '../../ports/Scheduler';
import { JobType } from '../../types/jobs';

const log = componentLogger('scheduler:cron');

/**
 * In-process cron, the local counterpart to EventBridge Scheduler.
 *
 * Enqueues the same DISPATCH_DUE_SYNCS message EventBridge would send, so the
 * downstream path is identical under both drivers - which is what makes the local
 * setup a real rehearsal rather than a separate code path.
 *
 * The obvious limitation, stated plainly: this only fires while the process is
 * running. Stop the worker and the schedule stops. EventBridge does not have that
 * property, which is the main reason to prefer it.
 */
export class NodeCronScheduler implements Scheduler {
  readonly provider = 'node-cron' as const;

  private task?: ScheduledTask;

  constructor(
    private readonly queue: Queue,
    private readonly expression: string,
  ) {}

  async ensureSchedules(): Promise<void> {
    if (!cron.validate(this.expression)) {
      throw new Error(`invalid cron expression: ${this.expression}`);
    }
  }

  async start(): Promise<void> {
    await this.ensureSchedules();

    this.task = cron.schedule(this.expression, () => {
      // Fire-and-forget by necessity: node-cron does not await the callback. The
      // catch is essential - an unhandled rejection here would take the process
      // down and stop all future ticks.
      this.queue
        .enqueue({ type: JobType.DISPATCH_DUE_SYNCS, kind: 'recent' })
        .then((messageId) => log.info({ messageId }, 'enqueued scheduled recent-media dispatch'))
        .catch((error) => log.error({ err: error }, 'failed to enqueue scheduled dispatch'));
    });

    log.info({ expression: this.expression }, 'cron scheduler started');
  }

  async stop(): Promise<void> {
    this.task?.stop();
    this.task = undefined;
    log.info('cron scheduler stopped');
  }
}
