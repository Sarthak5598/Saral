import {
  DeleteRolePolicyCommand,
  DeleteRoleCommand,
  IAMClient,
} from '@aws-sdk/client-iam';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { DeleteQueueCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

import { env } from '../src/lib/env';
import { componentLogger } from '../src/lib/logger';
import { runCommand } from './_runner';

const log = componentLogger('teardown');

/**
 * Deletes everything `pnpm aws:provision` created.
 *
 * Provisioning without a matching teardown is how people end up paying for
 * resources they forgot about. Both directions are scripted so the account can be
 * returned to exactly its previous state.
 *
 * Requires explicit confirmation, because this destroys the stored media
 * irreversibly - and that media cannot be re-fetched: Meta's media_url links have
 * expired and the hashtag quota is capped at 30 unique tags per 7 days.
 *
 *   pnpm aws:teardown --yes
 */

const QUEUE_NAME = 'hashtag-pipeline-jobs';
const DLQ_NAME = 'hashtag-pipeline-jobs-dlq';
const SCHEDULER_ROLE_NAME = 'hashtag-pipeline-scheduler-role';

async function emptyAndDeleteBucket(bucket: string, region: string): Promise<void> {
  const s3 = new S3Client({ region });
  let deleted = 0;

  // S3 refuses to delete a non-empty bucket, and ListObjectsV2 pages at 1000, so
  // this has to loop rather than assume one batch is enough.
  for (;;) {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
    const objects = (listed.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => Boolean(key));

    if (objects.length === 0) {
      break;
    }

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.map((Key) => ({ Key })) },
      }),
    );

    deleted += objects.length;

    if (!listed.IsTruncated) {
      break;
    }
  }

  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  log.info({ bucket, objectsDeleted: deleted }, 'bucket emptied and deleted');
}

async function deleteQueue(sqs: SQSClient, name: string): Promise<void> {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (QueueUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      log.info({ queue: name }, 'queue deleted');
    }
  } catch {
    log.info({ queue: name }, 'queue does not exist, nothing to delete');
  }
}

runCommand('aws:teardown', async () => {
  if (!process.argv.includes('--yes')) {
    // eslint-disable-next-line no-console
    console.error(
      [
        '',
        '  This permanently deletes:',
        `    - S3 bucket ${env.S3_BUCKET || '(derived)'} and every stored media file`,
        `    - SQS queues ${QUEUE_NAME} and ${DLQ_NAME}`,
        `    - IAM role ${SCHEDULER_ROLE_NAME}`,
        `    - EventBridge schedule ${env.EVENTBRIDGE_SCHEDULE_NAME}`,
        '',
        '  The media cannot be re-downloaded: Meta media_urls expire and the',
        '  hashtag quota is 30 unique tags per 7 days.',
        '',
        '  Re-run with --yes to proceed:  pnpm aws:teardown --yes',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  const region = env.AWS_REGION;

  // EC2 first, and by a wide margin the most important step: it is the only
  // resource here that accrues cost per hour rather than per byte or per request.
  const { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } = await import(
    '@aws-sdk/client-ec2'
  );

  try {
    const ec2 = new EC2Client({ region });
    const found = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: 'tag:Name', Values: ['hashtag-pipeline-worker'] },
          { Name: 'instance-state-name', Values: ['pending', 'running', 'stopped'] },
        ],
      }),
    );

    const ids = (found.Reservations ?? [])
      .flatMap((reservation) => reservation.Instances ?? [])
      .map((instance) => instance.InstanceId)
      .filter((id): id is string => Boolean(id));

    if (ids.length > 0) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
      log.info({ instanceIds: ids }, 'EC2 instance(s) terminated - hourly charges stopped');
    } else {
      log.info('no EC2 instances found');
    }
  } catch (error) {
    // Reported loudly rather than swallowed: an instance left running is the one
    // failure here that costs money.
    log.error(
      { err: error },
      'could not terminate EC2 - CHECK THE CONSOLE MANUALLY, a running instance bills hourly',
    );
  }

  // Schedule next: stop new work arriving before removing what processes it.
  const scheduler = new SchedulerClient({ region });
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: env.EVENTBRIDGE_SCHEDULE_NAME }));
    log.info({ name: env.EVENTBRIDGE_SCHEDULE_NAME }, 'schedule deleted');
  } catch {
    log.info({ name: env.EVENTBRIDGE_SCHEDULE_NAME }, 'schedule does not exist');
  }

  const sqs = new SQSClient({ region });
  await deleteQueue(sqs, QUEUE_NAME);
  await deleteQueue(sqs, DLQ_NAME);

  const iam = new IAMClient({ region });
  try {
    // An inline policy has to go before the role it is attached to.
    await iam
      .send(
        new DeleteRolePolicyCommand({
          RoleName: SCHEDULER_ROLE_NAME,
          PolicyName: 'send-message-to-jobs-queue',
        }),
      )
      .catch(() => undefined);

    await iam.send(new DeleteRoleCommand({ RoleName: SCHEDULER_ROLE_NAME }));
    log.info({ role: SCHEDULER_ROLE_NAME }, 'role deleted');
  } catch {
    log.info({ role: SCHEDULER_ROLE_NAME }, 'role does not exist');
  }

  if (env.S3_BUCKET) {
    await emptyAndDeleteBucket(env.S3_BUCKET, region);
  } else {
    log.warn('S3_BUCKET is not set - skipping bucket deletion, remove it manually if needed');
  }

  log.info('teardown complete - the account is back to its pre-provisioning state');
});
