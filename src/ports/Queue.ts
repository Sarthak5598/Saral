import type { Job } from '../types/jobs';

/**
 * Queue port.
 *
 * Modelled on SQS semantics rather than on the in-memory implementation, because
 * the constraints only run one way: code written against a perfect in-process
 * queue breaks on SQS, while code written against SQS works fine in memory.
 *
 * That means the contract is explicitly at-least-once, with visibility timeouts
 * and receipt handles - so consumers are forced to be idempotent from day one
 * instead of discovering the requirement at cutover.
 */

export interface QueueMessage {
  /** Provider message ID. Recorded on sync_runs to make redelivery visible. */
  id: string;
  job: Job;
  /**
   * Opaque token needed to delete or extend the message. SQS requires it and it
   * differs from the message ID; the in-memory driver mirrors the distinction so
   * the two behave the same.
   */
  receiptHandle: string;
  /**
   * How many times this message has been delivered. >1 means a previous attempt
   * failed or timed out - the signal a consumer uses to decide whether to keep
   * retrying or give up.
   */
  receivedCount: number;
}

export interface EnqueueOptions {
  /** Delay before the message becomes visible. Used to space out fan-out. */
  delaySeconds?: number;
}

export interface ReceiveOptions {
  maxMessages?: number;
  /** Long-poll duration. 0 means return immediately. */
  waitTimeSeconds?: number;
}

export interface Queue {
  readonly provider: 'local' | 'sqs';

  enqueue(job: Job, options?: EnqueueOptions): Promise<string>;

  /** Enqueue many. Providers may batch; SQS caps batches at 10. */
  enqueueBatch(jobs: Job[], options?: EnqueueOptions): Promise<string[]>;

  receive(options?: ReceiveOptions): Promise<QueueMessage[]>;

  /** Delete the message. Only called after the job has fully succeeded. */
  ack(message: QueueMessage): Promise<void>;

  /**
   * Return the message for redelivery. On SQS this resets the visibility timeout
   * to zero rather than deleting, so the redrive policy still counts the attempt
   * and a poison message eventually lands in the DLQ instead of looping forever.
   */
  nack(message: QueueMessage): Promise<void>;

  /**
   * Extend a message's visibility while it is still being worked on.
   *
   * Needed because a full sync can run ~11 minutes against Meta's slow edges. If
   * the visibility timeout expired mid-run, SQS would hand the same job to a
   * second worker while the first was still going.
   */
  extendVisibility(message: QueueMessage, seconds: number): Promise<void>;

  close(): Promise<void>;
}
