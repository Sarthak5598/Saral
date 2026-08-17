import { ZodError } from 'zod';

import { componentLogger } from '../lib/logger';
import type { Queue, QueueMessage } from '../ports/Queue';
import type { Job, JobType } from '../types/jobs';

const log = componentLogger('worker');

export type JobHandler = (job: Job, context: JobContext) => Promise<void>;

export interface JobContext {
  /** Provider message ID, recorded so redelivery is traceable in sync_runs. */
  messageId: string;
  /** >1 means a previous attempt failed. Handlers use this to resume or bail. */
  attempt: number;
  /** Aborted on shutdown so long-running work can stop cleanly. */
  signal: AbortSignal;
}

/**
 * Errors a handler can throw to say "do not retry this".
 *
 * Distinct from ordinary failures because the response differs: a retryable error
 * is nacked so the redrive policy eventually parks it in the DLQ, whereas a
 * permanently invalid job is acked and dropped - retrying a malformed payload
 * twelve times just delays the inevitable and fills the logs.
 */
export class UnprocessableJobError extends Error {}

export interface JobRunnerOptions {
  queue: Queue;
  handlers: Partial<Record<JobType, JobHandler>>;
  maxConcurrent?: number;
  waitTimeSeconds?: number;
  /**
   * How long the queue makes a message invisible. Used to size the heartbeat.
   * Must match the queue's configured visibility timeout.
   */
  visibilityTimeoutSeconds?: number;
  /**
   * Pause after an empty receive when long polling is disabled.
   *
   * Without this the poll loop spins with no delay and pegs a CPU core - the
   * queue returns immediately, the loop asks again, forever. Long polling
   * (waitTimeSeconds > 0) already provides the pause, so this only applies when
   * it is off, which is mainly tests and the in-memory driver.
   */
  emptyPollDelayMs?: number;
}

/**
 * Polls the queue and runs jobs.
 *
 * The subtlety worth reading: a full hashtag sync takes ~11 minutes against
 * Meta's slow edges, while the SQS visibility timeout is 5 minutes. Without
 * intervention SQS would redeliver the job halfway through and a second worker
 * would start the same sync concurrently. So each in-flight message gets a
 * heartbeat that extends its visibility while the work is still going.
 *
 * That is a genuine distributed-systems bug that only appears under load, and it
 * is why the in-memory queue emulates visibility timeouts too - so the behaviour
 * is exercised locally rather than discovered in AWS.
 */
export class JobRunner {
  private readonly queue: Queue;
  private readonly handlers: Partial<Record<JobType, JobHandler>>;
  private readonly maxConcurrent: number;
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeoutSeconds: number;
  private readonly emptyPollDelayMs: number;

  private readonly active = new Set<Promise<void>>();
  private readonly abortController = new AbortController();
  private running = false;

  constructor(options: JobRunnerOptions) {
    this.queue = options.queue;
    this.handlers = options.handlers;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.waitTimeSeconds = options.waitTimeSeconds ?? 20;
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 300;
    this.emptyPollDelayMs = options.emptyPollDelayMs ?? 25;
  }

  async start(): Promise<void> {
    this.running = true;
    log.info(
      { driver: this.queue.provider, maxConcurrent: this.maxConcurrent },
      'worker started, polling for jobs',
    );

    while (this.running) {
      // Backpressure: do not pull more work than there is capacity to run,
      // otherwise messages sit in-flight burning their visibility timeout while
      // waiting for a free slot.
      if (this.active.size >= this.maxConcurrent) {
        await Promise.race(this.active);
        continue;
      }

      let messages: QueueMessage[];

      try {
        messages = await this.queue.receive({
          maxMessages: Math.min(this.maxConcurrent - this.active.size, 10),
          waitTimeSeconds: this.waitTimeSeconds,
        });
      } catch (error) {
        if (!this.running) {
          break;
        }
        // A failed receive must not kill the worker - the queue may be briefly
        // unreachable. Pause so this does not become a hot error loop.
        log.error({ err: error }, 'failed to receive from queue');
        await this.delay(5_000);
        continue;
      }

      if (messages.length === 0) {
        // Yield before asking again. Long polling covers this when enabled; when
        // it is not, an unpaused loop is a busy-wait.
        if (this.waitTimeSeconds === 0) {
          await this.delay(this.emptyPollDelayMs);
        }
        continue;
      }

      for (const message of messages) {
        const task = this.process(message).finally(() => this.active.delete(task));
        this.active.add(task);
      }
    }

    // Let in-flight work finish rather than abandoning half-written syncs.
    await Promise.allSettled(this.active);
    log.info('worker stopped');
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    log.info({ inFlight: this.active.size }, 'stopping worker, waiting for in-flight jobs');
    this.running = false;
    this.abortController.abort();
  }

  private async process(message: QueueMessage): Promise<void> {
    const handler = this.handlers[message.job.type];
    const jobLog = log.child({
      messageId: message.id,
      type: message.job.type,
      attempt: message.receivedCount,
    });

    if (!handler) {
      // No handler registered. Acked, not nacked: an unknown type will never
      // become known by retrying, and leaving it would block nothing but fill the
      // DLQ with noise.
      jobLog.error('no handler registered for job type, dropping');
      await this.queue.ack(message);
      return;
    }

    // Extend visibility at half the timeout, so an extension always lands before
    // expiry even if one attempt is missed.
    const heartbeat = setInterval(
      () => {
        this.queue
          .extendVisibility(message, this.visibilityTimeoutSeconds)
          .catch((error) => jobLog.warn({ err: error }, 'failed to extend message visibility'));
      },
      Math.max((this.visibilityTimeoutSeconds * 1000) / 2, 30_000),
    );

    const startedAt = Date.now();

    try {
      await handler(message.job, {
        messageId: message.id,
        attempt: message.receivedCount,
        signal: this.abortController.signal,
      });

      await this.queue.ack(message);
      jobLog.info({ durationMs: Date.now() - startedAt }, 'job completed');
    } catch (error) {
      // A malformed payload or a permanently invalid job: drop it.
      if (error instanceof UnprocessableJobError || error instanceof ZodError) {
        jobLog.error({ err: error }, 'job is unprocessable, dropping without retry');
        await this.queue.ack(message);
        return;
      }

      jobLog.error(
        { err: error, durationMs: Date.now() - startedAt },
        'job failed, returning to queue for retry',
      );

      // Nack rather than ack so the attempt counts toward maxReceiveCount and a
      // permanently failing job ends up in the DLQ instead of cycling forever.
      await this.queue.nack(message).catch((nackError) => {
        jobLog.error({ err: nackError }, 'failed to nack message');
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
