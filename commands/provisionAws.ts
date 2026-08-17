import {
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

import { EventBridgeScheduler } from '../src/adapters/aws/EventBridgeScheduler';
import { toEventBridgeExpression } from '../src/adapters/index';
import { env } from '../src/lib/env';
import { componentLogger } from '../src/lib/logger';

const log = componentLogger('provision');

/**
 * Creates the AWS infrastructure this pipeline needs, idempotently.
 *
 * Scripted rather than hand-clicked so the infrastructure is visible in the
 * repository and reproducible by a reviewer. Hand-created resources are invisible
 * in git and impossible to verify.
 *
 * Everything here is inside the AWS free tier at this pipeline's volume: SQS
 * covers 1M requests/month, S3 5GB, EventBridge Scheduler 14M invocations.
 *
 * Deliberately NOT created: RDS. Postgres stays in Docker so that a reviewer who
 * clones the repo can run it without credentials of ours.
 */

const QUEUE_NAME = 'hashtag-pipeline-jobs';
const DLQ_NAME = 'hashtag-pipeline-jobs-dlq';
const SCHEDULER_ROLE_NAME = 'hashtag-pipeline-scheduler-role';

async function resolveAccountId(region: string): Promise<string> {
  const sts = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));

  if (!identity.Account) {
    throw new Error('could not resolve AWS account ID');
  }

  log.info({ account: identity.Account, arn: identity.Arn }, 'authenticated');
  return identity.Account;
}

/**
 * Bucket names are globally unique across all of AWS, so the account ID is
 * suffixed to make collisions impossible without needing a random name that
 * would change on every run.
 */
async function ensureBucket(region: string, accountId: string): Promise<string> {
  const bucket = env.S3_BUCKET || `hashtag-media-${accountId}`;
  const s3 = new S3Client({ region });

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    log.info({ bucket }, 'bucket already exists');
  } catch {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // us-east-1 rejects an explicit LocationConstraint; every other region
        // requires one.
        ...(region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
    log.info({ bucket, region }, 'created bucket');
  }

  // The media is other people's copyrighted content pulled from a public API.
  // Blocking public access is the correct default and stops an accidental
  // public-read ACL from turning this into an open CDN.
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );

  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    }),
  );

  log.info({ bucket }, 'bucket hardened: public access blocked, SSE-S256 enabled');
  return bucket;
}

async function ensureQueueUrl(sqs: SQSClient, name: string): Promise<string> {
  try {
    const existing = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (existing.QueueUrl) {
      log.info({ queue: name }, 'queue already exists');
      return existing.QueueUrl;
    }
  } catch {
    // Falls through to creation.
  }

  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        VisibilityTimeout: String(env.SQS_VISIBILITY_TIMEOUT),
        // Keep failed messages long enough to actually investigate them.
        MessageRetentionPeriod: '1209600', // 14 days, the SQS maximum
      },
    }),
  );

  if (!created.QueueUrl) {
    throw new Error(`failed to create queue ${name}`);
  }

  log.info({ queue: name, url: created.QueueUrl }, 'created queue');
  return created.QueueUrl;
}

async function queueArn(sqs: SQSClient, url: string): Promise<string> {
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
  );

  const arn = attrs.Attributes?.QueueArn;
  if (!arn) {
    throw new Error(`could not resolve ARN for ${url}`);
  }
  return arn;
}

/**
 * Creates the main queue and its dead-letter queue, wired by a redrive policy.
 *
 * The DLQ is what stops a poison message looping forever: after 3 failed
 * deliveries SQS parks it where it can be inspected, instead of the worker
 * retrying it indefinitely and burying real failures in log noise.
 */
async function ensureQueues(region: string): Promise<{ queueUrl: string; dlqUrl: string }> {
  const sqs = new SQSClient({ region });

  const dlqUrl = await ensureQueueUrl(sqs, DLQ_NAME);
  const dlqArn = await queueArn(sqs, dlqUrl);

  const queueUrl = await ensureQueueUrl(sqs, QUEUE_NAME);

  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 3 }),
        VisibilityTimeout: String(env.SQS_VISIBILITY_TIMEOUT),
      },
    }),
  );

  log.info({ queue: QUEUE_NAME, dlq: DLQ_NAME, maxReceiveCount: 3 }, 'redrive policy applied');
  return { queueUrl, dlqUrl };
}

/**
 * The role EventBridge Scheduler assumes in order to call sqs:SendMessage.
 *
 * This is the step people usually get stuck on: the schedule cannot write to a
 * queue on its own, it needs a role whose trust policy names
 * scheduler.amazonaws.com as principal. The permission is scoped to this one
 * queue rather than sqs:* on everything.
 */
async function ensureSchedulerRole(region: string, targetQueueArn: string): Promise<string> {
  const iam = new IAMClient({ region });

  const trustPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'scheduler.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  };

  let roleArn: string | undefined;

  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: SCHEDULER_ROLE_NAME }));
    roleArn = existing.Role?.Arn;
    log.info({ role: SCHEDULER_ROLE_NAME }, 'scheduler role already exists');
  } catch {
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: SCHEDULER_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description: 'Lets EventBridge Scheduler enqueue hashtag sync jobs onto SQS',
      }),
    );
    roleArn = created.Role?.Arn;
    log.info({ role: SCHEDULER_ROLE_NAME, arn: roleArn }, 'created scheduler role');
  }

  if (!roleArn) {
    throw new Error('could not resolve scheduler role ARN');
  }

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: SCHEDULER_ROLE_NAME,
      PolicyName: 'send-message-to-jobs-queue',
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: targetQueueArn },
        ],
      }),
    }),
  );

  log.info({ role: SCHEDULER_ROLE_NAME, targetQueueArn }, 'scoped send-message policy attached');
  return roleArn;
}

async function main(): Promise<void> {
  const region = env.AWS_REGION;
  log.info({ region }, 'provisioning AWS infrastructure');

  const accountId = await resolveAccountId(region);
  const bucket = await ensureBucket(region, accountId);
  const { queueUrl, dlqUrl } = await ensureQueues(region);

  const sqs = new SQSClient({ region });
  const mainArn = await queueArn(sqs, queueUrl);

  const roleArn = await ensureSchedulerRole(region, mainArn);

  // IAM role propagation is eventually consistent - EventBridge can reject a
  // freshly created role as unassumable. A short pause avoids a confusing failure
  // on a first run that succeeds on the second.
  log.info('waiting 10s for IAM role propagation');
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  const scheduler = new EventBridgeScheduler({
    scheduleName: env.EVENTBRIDGE_SCHEDULE_NAME,
    scheduleExpression: toEventBridgeExpression(env.RECENT_SYNC_CRON),
    queueUrl,
    roleArn,
    region,
  });

  await scheduler.ensureSchedules();

  // Printed rather than written to .env: overwriting a file holding a live token
  // without being asked is not this script's business.
  const summary = [
    '',
    '  Provisioning complete. Put these in your .env to switch drivers:',
    '',
    '    QUEUE_DRIVER=aws',
    '    STORAGE_DRIVER=aws',
    '    SCHEDULER_DRIVER=aws',
    `    AWS_REGION=${region}`,
    `    S3_BUCKET=${bucket}`,
    `    SQS_QUEUE_URL=${queueUrl}`,
    `    SQS_DLQ_URL=${dlqUrl}`,
    `    EVENTBRIDGE_SCHEDULE_ROLE_ARN=${roleArn}`,
    '',
    '  IAMFullAccess is only needed for provisioning - safe to detach now.',
    '',
  ].join('\n');

  // eslint-disable-next-line no-console
  console.log(summary);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.fatal({ err: error }, 'provisioning failed');
    process.exit(1);
  });
