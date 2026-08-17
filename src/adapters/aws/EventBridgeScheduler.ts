import {
  ConflictException,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

import { componentLogger } from '../../lib/logger';
import type { Scheduler } from '../../ports/Scheduler';
import { JobType } from '../../types/jobs';

const log = componentLogger('scheduler:eventbridge');

/**
 * EventBridge Scheduler driver.
 *
 * The schedule targets SQS directly - SendMessage is a native target, so no
 * Lambda is involved. That choice is deliberate: a Lambda would need network
 * access to Postgres, which would force RDS plus VPC configuration, when the
 * assignment needs neither.
 *
 * The message body is static, because an EventBridge schedule cannot query
 * anything. It sends DISPATCH_DUE_SYNCS and the worker resolves which hashtags
 * are due from the database. So tracking a new hashtag is a row insert - the AWS
 * infrastructure never has to change.
 */
export class EventBridgeScheduler implements Scheduler {
  readonly provider = 'eventbridge' as const;

  private readonly client: SchedulerClient;
  private readonly sqs: SQSClient;

  constructor(
    private readonly options: {
      scheduleName: string;
      /** EventBridge syntax: a 6-field `cron(...)` or a `rate(3 hours)` expression. */
      scheduleExpression: string;
      queueUrl: string;
      /** Role EventBridge assumes to call sqs:SendMessage. */
      roleArn: string;
      region: string;
    },
    clients?: { scheduler?: SchedulerClient; sqs?: SQSClient },
  ) {
    this.client = clients?.scheduler ?? new SchedulerClient({ region: options.region });
    this.sqs = clients?.sqs ?? new SQSClient({ region: options.region });
  }

  /** The target needs the queue ARN, but config carries the URL. */
  private async resolveQueueArn(): Promise<string> {
    const result = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.options.queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );

    const arn = result.Attributes?.QueueArn;
    if (!arn) {
      throw new Error(`could not resolve QueueArn for ${this.options.queueUrl}`);
    }
    return arn;
  }

  /**
   * Creates the schedule, or updates it if it already exists.
   *
   * Idempotent so it can run on every boot and via `pnpm aws:provision` without
   * drifting or erroring.
   */
  async ensureSchedules(): Promise<void> {
    const queueArn = await this.resolveQueueArn();

    const target = {
      Arn: queueArn,
      RoleArn: this.options.roleArn,
      Input: JSON.stringify({ type: JobType.DISPATCH_DUE_SYNCS, kind: 'recent' }),
    };

    const shared = {
      Name: this.options.scheduleName,
      ScheduleExpression: this.options.scheduleExpression,
      // OFF means fire at the exact time rather than within a jitter window. The
      // 3-hour cadence is a requirement, so predictability beats load-spreading.
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      Target: target,
      Description: 'Enqueues a recent-media sync dispatch for all tracked hashtags',
      State: 'ENABLED' as const,
    };

    try {
      await this.client.send(new CreateScheduleCommand(shared));
      log.info(
        { name: this.options.scheduleName, expression: this.options.scheduleExpression },
        'created EventBridge schedule',
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        await this.client.send(new UpdateScheduleCommand(shared));
        log.info({ name: this.options.scheduleName }, 'updated existing EventBridge schedule');
        return;
      }
      throw error;
    }
  }

  /**
   * No-op. AWS owns the clock - the schedule fires whether or not this process is
   * alive, which is precisely the advantage over node-cron.
   */
  async start(): Promise<void> {
    log.info(
      { name: this.options.scheduleName },
      'EventBridge owns the schedule; nothing to run in-process',
    );
  }

  /** Also a no-op: stopping our process must not disable the AWS schedule. */
  async stop(): Promise<void> {}
}
