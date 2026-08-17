import { describe, expect, it } from 'vitest';

import { InMemoryQueue } from '../../src/adapters/local/InMemoryQueue';
import { toEventBridgeExpression } from '../../src/adapters/index';
import { JobRunner, UnprocessableJobError } from '../../src/worker/JobRunner';
import { JobType, type Job } from '../../src/types/jobs';

const HASHTAG_UUID = '7684e242-1176-45b8-968e-2c0d674f0742';

function syncJob(): Job {
  return { type: JobType.SYNC_RECENT_HASHTAG_MEDIA, hashtagId: HASHTAG_UUID };
}

describe('InMemoryQueue emulates SQS semantics', () => {
  it('makes a received message invisible rather than deleting it', async () => {
    const queue = new InMemoryQueue(60_000, 3);
    await queue.enqueue(syncJob());

    const first = await queue.receive({ maxMessages: 10 });
    expect(first).toHaveLength(1);

    // Still in flight, so a second consumer must not see it.
    const second = await queue.receive({ maxMessages: 10 });
    expect(second).toHaveLength(0);
    expect(queue.inFlightCount).toBe(1);
  });

  it('redelivers a nacked message with an incremented receive count', async () => {
    const queue = new InMemoryQueue(60_000, 3);
    await queue.enqueue(syncJob());

    const [first] = await queue.receive({ maxMessages: 1 });
    expect(first?.receivedCount).toBe(1);

    await queue.nack(first!);

    const [second] = await queue.receive({ maxMessages: 1 });
    expect(second?.receivedCount).toBe(2);
    // Same message, but the old receipt handle must no longer be valid.
    expect(second?.id).toBe(first?.id);
    expect(second?.receiptHandle).not.toBe(first?.receiptHandle);
  });

  it('moves a message to the DLQ once maxReceiveCount is exceeded', async () => {
    const queue = new InMemoryQueue(60_000, 2);
    await queue.enqueue(syncJob());

    // Two deliveries are allowed; the third trips the ceiling.
    for (let i = 0; i < 2; i += 1) {
      const [message] = await queue.receive({ maxMessages: 1 });
      expect(message).toBeDefined();
      await queue.nack(message!);
    }

    const afterCeiling = await queue.receive({ maxMessages: 1 });
    expect(afterCeiling).toHaveLength(0);
    expect(queue.deadLetterCount).toBe(1);
  });

  it('removes the message permanently on ack', async () => {
    const queue = new InMemoryQueue(50, 3);
    await queue.enqueue(syncJob());

    const [message] = await queue.receive({ maxMessages: 1 });
    await queue.ack(message!);

    // Past the visibility timeout, an acked message must not come back.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await queue.receive({ maxMessages: 1 })).toHaveLength(0);
  });

  it('honours enqueue delay', async () => {
    const queue = new InMemoryQueue(60_000, 3);
    await queue.enqueue(syncJob(), { delaySeconds: 1 });

    expect(await queue.receive({ maxMessages: 1 })).toHaveLength(0);
    expect(await queue.receive({ maxMessages: 1, waitTimeSeconds: 2 })).toHaveLength(1);
  });
});

describe('JobRunner', () => {
  it('acks on success and stops after draining', async () => {
    const queue = new InMemoryQueue(60_000, 3);
    await queue.enqueue(syncJob());

    const seen: Job[] = [];
    const runner = new JobRunner({
      queue,
      waitTimeSeconds: 0,
      handlers: {
        [JobType.SYNC_RECENT_HASHTAG_MEDIA]: async (job) => {
          seen.push(job);
        },
      },
    });

    const loop = runner.start();
    await waitUntil(() => seen.length === 1);
    await runner.stop();
    await loop;

    expect(seen).toHaveLength(1);
    expect(queue.depth).toBe(0);
    expect(queue.inFlightCount).toBe(0);
  });

  it('returns a failed job to the queue for retry', async () => {
    const queue = new InMemoryQueue(60_000, 5);
    await queue.enqueue(syncJob());

    let attempts = 0;
    const runner = new JobRunner({
      queue,
      waitTimeSeconds: 0,
      handlers: {
        [JobType.SYNC_RECENT_HASHTAG_MEDIA]: async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error('transient failure');
          }
        },
      },
    });

    const loop = runner.start();
    await waitUntil(() => attempts >= 3);
    await runner.stop();
    await loop;

    // Failed twice, succeeded on the third delivery, then acked.
    expect(attempts).toBe(3);
    expect(queue.depth).toBe(0);
  });

  it('drops an unprocessable job instead of retrying it', async () => {
    const queue = new InMemoryQueue(60_000, 5);
    await queue.enqueue(syncJob());

    let attempts = 0;
    const runner = new JobRunner({
      queue,
      waitTimeSeconds: 0,
      handlers: {
        [JobType.SYNC_RECENT_HASHTAG_MEDIA]: async () => {
          attempts += 1;
          throw new UnprocessableJobError('payload will never be valid');
        },
      },
    });

    const loop = runner.start();
    await waitUntil(() => attempts >= 1);
    // Give the loop room to redeliver if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runner.stop();
    await loop;

    expect(attempts).toBe(1);
    expect(queue.depth).toBe(0);
    expect(queue.deadLetterCount).toBe(0);
  });

  it('drops a job with no registered handler', async () => {
    const queue = new InMemoryQueue(60_000, 5);
    await queue.enqueue({ type: JobType.DOWNLOAD_MEDIA_ASSET, mediaId: HASHTAG_UUID });

    const runner = new JobRunner({ queue, waitTimeSeconds: 0, handlers: {} });

    const loop = runner.start();
    await waitUntil(() => queue.depth === 0 && queue.inFlightCount === 0);
    await runner.stop();
    await loop;

    expect(queue.deadLetterCount).toBe(0);
  });

  it('respects maxConcurrent', async () => {
    const queue = new InMemoryQueue(60_000, 5);
    for (let i = 0; i < 6; i += 1) {
      await queue.enqueue(syncJob());
    }

    let concurrent = 0;
    let peak = 0;
    let completed = 0;

    const runner = new JobRunner({
      queue,
      waitTimeSeconds: 0,
      maxConcurrent: 2,
      handlers: {
        [JobType.SYNC_RECENT_HASHTAG_MEDIA]: async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 30));
          concurrent -= 1;
          completed += 1;
        },
      },
    });

    const loop = runner.start();
    await waitUntil(() => completed === 6, 5_000);
    await runner.stop();
    await loop;

    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('toEventBridgeExpression', () => {
  it('converts the 5-field default to EventBridge 6-field form', () => {
    // EventBridge forbids specifying both day-of-month and day-of-week; one must
    // be '?'. Passing a Unix expression through unchanged yields a schedule that
    // is rejected or never fires.
    expect(toEventBridgeExpression('0 */3 * * *')).toBe('cron(0 */3 * * ? *)');
  });

  it('rejects an expression with the wrong field count', () => {
    expect(() => toEventBridgeExpression('0 */3 * *')).toThrow(/5-field/);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
