import { randomUUID } from 'node:crypto';

import { componentLogger } from '../../lib/logger';
import type {
  EnqueueOptions,
  Queue,
  QueueMessage,
  ReceiveOptions,
} from '../../ports/Queue';
import type { Job } from '../../types/jobs';

const log = componentLogger('queue:local');

interface Envelope {
  id: string;
  job: Job;
  receiptHandle: string;
  receivedCount: number;
  /** Epoch ms before which the message is invisible. */
  visibleAt: number;
}

/**
 * In-memory queue for local development and tests.
 *
 * Deliberately emulates the SQS behaviours that catch people out, rather than
 * being a convenient array:
 *
 *  - messages become invisible for a visibility timeout instead of disappearing
 *  - `ack` is required, and forgetting it means redelivery
 *  - `receivedCount` increments, so poison-message handling can be exercised
 *  - a maxReceiveCount ceiling mirrors the SQS redrive policy into a local DLQ
 *
 * The point is that a consumer which works here works on SQS. A simpler
 * implementation would let non-idempotent code pass locally and fail in AWS.
 */
export class InMemoryQueue implements Queue {
  readonly provider = 'local' as const;

  private readonly messages: Envelope[] = [];
  private readonly inFlight = new Map<string, Envelope>();
  /** Local stand-in for the SQS dead-letter queue. */
  private readonly deadLetters: Envelope[] = [];
  private closed = false;

  constructor(
    private readonly visibilityTimeoutMs = 300_000,
    private readonly maxReceiveCount = 3,
  ) {}

  async enqueue(job: Job, options?: EnqueueOptions): Promise<string> {
    if (this.closed) {
      throw new Error('queue is closed');
    }

    const id = randomUUID();
    this.messages.push({
      id,
      job,
      receiptHandle: randomUUID(),
      receivedCount: 0,
      visibleAt: Date.now() + (options?.delaySeconds ?? 0) * 1000,
    });

    log.debug({ messageId: id, type: job.type }, 'enqueued');
    return id;
  }

  async enqueueBatch(jobs: Job[], options?: EnqueueOptions): Promise<string[]> {
    return Promise.all(jobs.map((job) => this.enqueue(job, options)));
  }

  async receive(options?: ReceiveOptions): Promise<QueueMessage[]> {
    const max = options?.maxMessages ?? 1;
    const waitMs = (options?.waitTimeSeconds ?? 0) * 1000;
    const deadline = Date.now() + waitMs;

    // Emulates long polling: keep checking until something is visible or the
    // wait expires. Without this the worker loop would spin hot on an empty queue.
    for (;;) {
      const now = Date.now();
      const ready: QueueMessage[] = [];

      for (let i = 0; i < this.messages.length && ready.length < max; i += 1) {
        const envelope = this.messages[i];
        if (!envelope || envelope.visibleAt > now) {
          continue;
        }

        this.messages.splice(i, 1);
        i -= 1;

        envelope.receivedCount += 1;

        // Redrive: a message that has failed too many times is parked rather than
        // retried forever.
        if (envelope.receivedCount > this.maxReceiveCount) {
          this.deadLetters.push(envelope);
          log.error(
            { messageId: envelope.id, type: envelope.job.type, receivedCount: envelope.receivedCount },
            'message exceeded maxReceiveCount, moved to local DLQ',
          );
          continue;
        }

        // Fresh handle per delivery, matching SQS - an old handle must not work.
        envelope.receiptHandle = randomUUID();
        envelope.visibleAt = now + this.visibilityTimeoutMs;
        this.inFlight.set(envelope.receiptHandle, envelope);

        ready.push({
          id: envelope.id,
          job: envelope.job,
          receiptHandle: envelope.receiptHandle,
          receivedCount: envelope.receivedCount,
        });
      }

      if (ready.length > 0 || this.closed || Date.now() >= deadline) {
        return ready;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async ack(message: QueueMessage): Promise<void> {
    this.inFlight.delete(message.receiptHandle);
    log.debug({ messageId: message.id }, 'acked');
  }

  async nack(message: QueueMessage): Promise<void> {
    const envelope = this.inFlight.get(message.receiptHandle);
    if (!envelope) {
      return;
    }

    this.inFlight.delete(message.receiptHandle);
    // Immediately visible again, preserving receivedCount so the DLQ ceiling
    // still applies.
    envelope.visibleAt = Date.now();
    this.messages.push(envelope);
    log.debug({ messageId: message.id, receivedCount: envelope.receivedCount }, 'nacked');
  }

  async extendVisibility(message: QueueMessage, seconds: number): Promise<void> {
    const envelope = this.inFlight.get(message.receiptHandle);
    if (envelope) {
      envelope.visibleAt = Date.now() + seconds * 1000;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // --- test/inspection helpers -------------------------------------------

  get depth(): number {
    return this.messages.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get deadLetterCount(): number {
    return this.deadLetters.length;
  }
}
