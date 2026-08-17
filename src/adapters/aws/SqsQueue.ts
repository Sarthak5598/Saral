import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { componentLogger } from '../../lib/logger';
import type { EnqueueOptions, Queue, QueueMessage, ReceiveOptions } from '../../ports/Queue';
import { jobSchema, type Job } from '../../types/jobs';

const log = componentLogger('queue:sqs');

/** SQS caps SendMessageBatch at 10 entries. */
const SQS_BATCH_LIMIT = 10;

/**
 * SQS driver.
 *
 * Two behaviours worth being explicit about, because they shape the consumers:
 *
 *  - Delivery is at-least-once. A message can be handed out twice even when
 *    nothing failed, so every consumer must be idempotent. The database
 *    constraints (UNIQUE on ig_media_id, UNIQUE on media+run for snapshots) are
 *    what actually enforce that.
 *
 *  - Message bodies are untrusted input. Under AWS the DISPATCH_DUE_SYNCS message
 *    is authored by EventBridge, not by our code, and an old deploy's messages can
 *    still be in flight. Bodies are Zod-parsed here, and a body that fails
 *    validation is dropped to the DLQ rather than crashing the worker.
 */
export class SqsQueue implements Queue {
  readonly provider = 'sqs' as const;

  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    region: string,
    private readonly defaultWaitTimeSeconds = 20,
    client?: SQSClient,
  ) {
    this.client = client ?? new SQSClient({ region });
  }

  async enqueue(job: Job, options?: EnqueueOptions): Promise<string> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(job),
        ...(options?.delaySeconds ? { DelaySeconds: options.delaySeconds } : {}),
      }),
    );

    const id = result.MessageId ?? '';
    log.debug({ messageId: id, type: job.type }, 'enqueued');
    return id;
  }

  async enqueueBatch(jobs: Job[], options?: EnqueueOptions): Promise<string[]> {
    const ids: string[] = [];

    for (let offset = 0; offset < jobs.length; offset += SQS_BATCH_LIMIT) {
      const chunk = jobs.slice(offset, offset + SQS_BATCH_LIMIT);

      const result = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((job, index) => ({
            Id: String(offset + index),
            MessageBody: JSON.stringify(job),
            ...(options?.delaySeconds ? { DelaySeconds: options.delaySeconds } : {}),
          })),
        }),
      );

      ids.push(...(result.Successful ?? []).map((entry) => entry.MessageId ?? ''));

      // Partial batch failure is normal and must not be swallowed - otherwise a
      // sync would silently skip assets it believed it had queued.
      if (result.Failed && result.Failed.length > 0) {
        log.error(
          { failed: result.Failed.map((f) => ({ id: f.Id, code: f.Code, message: f.Message })) },
          'some messages failed to enqueue',
        );
        throw new Error(`failed to enqueue ${result.Failed.length} of ${chunk.length} messages`);
      }
    }

    return ids;
  }

  async receive(options?: ReceiveOptions): Promise<QueueMessage[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(options?.maxMessages ?? 1, 10),
        // Long polling: without it the worker burns requests returning empty.
        WaitTimeSeconds: options?.waitTimeSeconds ?? this.defaultWaitTimeSeconds,
        // MessageSystemAttributeNames, not the deprecated AttributeNames - the
        // latter no longer accepts this value in current SDK versions.
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    const messages: QueueMessage[] = [];

    for (const raw of result.Messages ?? []) {
      if (!raw.Body || !raw.ReceiptHandle) {
        continue;
      }

      const parsed = this.parseBody(raw.Body);

      if (!parsed) {
        // Unparseable body. Deleting it would hide the problem; leaving it lets
        // the redrive policy move it to the DLQ where it can be inspected.
        log.error(
          { messageId: raw.MessageId, bodyPreview: raw.Body.slice(0, 200) },
          'dropping unparseable message body - will redrive to DLQ',
        );
        continue;
      }

      messages.push({
        id: raw.MessageId ?? '',
        job: parsed,
        receiptHandle: raw.ReceiptHandle,
        receivedCount: Number(raw.Attributes?.ApproximateReceiveCount ?? '1'),
      });
    }

    return messages;
  }

  private parseBody(body: string): Job | undefined {
    try {
      const result = jobSchema.safeParse(JSON.parse(body));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  async ack(message: QueueMessage): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.receiptHandle,
      }),
    );
  }

  /**
   * Sets visibility to 0 so the message is immediately redeliverable.
   *
   * Not a delete: the attempt still counts toward the redrive policy's
   * maxReceiveCount, so a permanently failing message ends up in the DLQ instead
   * of cycling forever.
   */
  async nack(message: QueueMessage): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  async extendVisibility(message: QueueMessage, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.receiptHandle,
        // SQS hard-caps the visibility timeout at 12 hours.
        VisibilityTimeout: Math.min(seconds, 43_200),
      }),
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
