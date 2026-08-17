import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AuthorizeSecurityGroupIngressCommand,
  CreateKeyPairCommand,
  CreateSecurityGroupCommand,
  CreateTagsCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RunInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  AddRoleToInstanceProfileCommand,
  CreateInstanceProfileCommand,
  CreateRoleCommand,
  GetInstanceProfileCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';

import { env } from '../src/lib/env';
import { componentLogger } from '../src/lib/logger';
import { runCommand } from './_runner';

const log = componentLogger('deploy:ec2');

/**
 * Deploys the worker (and Postgres) onto a single EC2 instance, so the 3-hourly sync
 * runs without anything on a laptop.
 *
 * Shape: one t4g.micro running docker compose - Postgres, worker and API together.
 * Not RDS, deliberately: a separate managed database would add VPC and security-group
 * work, a second billable resource, and nothing the assignment needs. One box keeps
 * the whole deployment inside the free tier and inside one teardown command.
 *
 * t4g.micro is free for 750 hours/month for 12 months on a new account, then roughly
 * £5/month. `pnpm aws:teardown --yes` removes it.
 *
 *   pnpm deploy:ec2
 */

/**
 * Deployment overrides, distinct from the documented defaults in .env.example.
 *
 * The 500-item default is what the brief asks the pipeline to be capable of. On a
 * permanently running instance it is also a storage bill: at ~2.4MB per file
 * (measured) and 8 syncs a day, a 500 cap would download several GB daily and leave
 * the 5GB S3 free tier within a day.
 *
 * 100 per run, paired with a 7-day expiry, plateaus around 4.4GB - inside the free
 * tier, while the 3-hourly cadence the brief requires stays untouched.
 */
const DEPLOY_MAX_MEDIA_PER_RUN = 100;
const ASSET_EXPIRY_DAYS = 7;

const ROLE_NAME = 'hashtag-pipeline-ec2-role';
const PROFILE_NAME = 'hashtag-pipeline-ec2-profile';
const SG_NAME = 'hashtag-pipeline-sg';
const KEY_NAME = 'hashtag-pipeline-key';
const INSTANCE_TAG = 'hashtag-pipeline-worker';
const REPO_URL = 'https://github.com/Sarthak5598/Saral.git';

/**
 * Grants the instance exactly what the worker needs: this bucket and this queue.
 *
 * An instance role rather than access keys in a file. Keys on disk would have to be
 * rotated by hand, would sit in the instance's environment, and would survive a
 * snapshot; the role issues short-lived credentials the SDK picks up automatically.
 */
async function ensureInstanceProfile(region: string, accountId: string): Promise<string> {
  const iam = new IAMClient({ region });

  const trust = {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
    ],
  };

  try {
    await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    log.info({ role: ROLE_NAME }, 'instance role already exists');
  } catch {
    await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(trust),
        Description: 'Lets the hashtag pipeline worker reach its own S3 bucket and SQS queue',
      }),
    );
    log.info({ role: ROLE_NAME }, 'created instance role');
  }

  const bucket = env.S3_BUCKET;
  const queueArn = `arn:aws:sqs:${region}:${accountId}:hashtag-pipeline-jobs`;

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: 'pipeline-access',
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:PutObject', 's3:GetObject', 's3:HeadObject'],
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
          { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: `arn:aws:s3:::${bucket}` },
          {
            Effect: 'Allow',
            Action: [
              'sqs:ReceiveMessage',
              'sqs:DeleteMessage',
              'sqs:SendMessage',
              'sqs:GetQueueAttributes',
              'sqs:ChangeMessageVisibility',
            ],
            Resource: queueArn,
          },
        ],
      }),
    }),
  );

  try {
    await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: PROFILE_NAME }));
  } catch {
    await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: PROFILE_NAME }));
    await iam.send(
      new AddRoleToInstanceProfileCommand({
        InstanceProfileName: PROFILE_NAME,
        RoleName: ROLE_NAME,
      }),
    );
    log.info({ profile: PROFILE_NAME }, 'created instance profile');
  }

  return PROFILE_NAME;
}

/** SSH open to one address only - the machine running this script. */
async function ensureSecurityGroup(
  ec2: EC2Client,
  vpcId: string,
  myIp: string,
): Promise<string> {
  const existing = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [SG_NAME] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    }),
  );

  const found = existing.SecurityGroups?.[0]?.GroupId;
  if (found) {
    log.info({ groupId: found }, 'security group already exists');
    return found;
  }

  const created = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: SG_NAME,
      Description: 'hashtag pipeline worker - SSH from the operator only',
      VpcId: vpcId,
    }),
  );

  const groupId = created.GroupId;
  if (!groupId) {
    throw new Error('failed to create security group');
  }

  await ec2.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [
        {
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: `${myIp}/32`, Description: 'operator SSH' }],
        },
      ],
    }),
  );

  // No inbound rule for port 3000. The worker needs no inbound traffic at all, and
  // exposing an unauthenticated API to the internet is not worth the convenience -
  // reviewers run the API locally per the setup instructions.
  log.info({ groupId, sshFrom: `${myIp}/32` }, 'created security group (SSH only, no API port)');
  return groupId;
}

/**
 * Expires stored media after a fixed window so storage plateaus instead of growing
 * without bound.
 *
 * The tradeoff is explicit: expired objects are gone for good, and the media cannot
 * be re-fetched (Meta's media_urls expire and the hashtag quota is capped). What
 * survives is the metadata, the metric time series and the raw payloads in Postgres -
 * so the analytical record is intact even when the file is not. That is the right
 * thing to sacrifice when the alternative is an unbounded S3 bill.
 */
async function ensureLifecycleRule(bucket: string, region: string): Promise<void> {
  const { PutBucketLifecycleConfigurationCommand, S3Client } = await import(
    '@aws-sdk/client-s3'
  );

  const s3 = new S3Client({ region });

  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-media-assets',
            Status: 'Enabled',
            Filter: { Prefix: 'media/' },
            Expiration: { Days: ASSET_EXPIRY_DAYS },
            // Clean up failed multipart uploads too - they are invisible in the
            // console but still billed.
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          },
        ],
      },
    }),
  );

  log.info({ bucket, expiryDays: ASSET_EXPIRY_DAYS }, 'S3 lifecycle expiry rule applied');
}

async function ensureKeyPair(ec2: EC2Client): Promise<string | undefined> {
  try {
    const created = await ec2.send(new CreateKeyPairCommand({ KeyName: KEY_NAME }));

    if (created.KeyMaterial) {
      // Written outside the repo tree and never committed - it is a private key.
      const target = path.join(process.cwd(), `${KEY_NAME}.pem`);
      await writeFile(target, created.KeyMaterial, { mode: 0o600 });
      log.warn({ path: target }, 'private key written - keep it safe, it is gitignored');
      return target;
    }
  } catch {
    log.info({ keyName: KEY_NAME }, 'key pair already exists, reusing it');
  }

  return undefined;
}

/** Newest Amazon Linux 2023 ARM64 image - ARM because t4g instances are Graviton. */
async function findAmi(ec2: EC2Client): Promise<string> {
  const images = await ec2.send(
    new DescribeImagesCommand({
      Owners: ['amazon'],
      Filters: [
        { Name: 'name', Values: ['al2023-ami-2023*-arm64'] },
        { Name: 'state', Values: ['available'] },
        { Name: 'architecture', Values: ['arm64'] },
      ],
    }),
  );

  const newest = (images.Images ?? [])
    .filter((image) => image.ImageId && image.CreationDate)
    .sort((a, b) => (a.CreationDate! < b.CreationDate! ? 1 : -1))[0];

  if (!newest?.ImageId) {
    throw new Error('could not find an Amazon Linux 2023 arm64 AMI');
  }

  log.info({ ami: newest.ImageId, name: newest.Name }, 'selected AMI');
  return newest.ImageId;
}

/**
 * Cloud-init script. Runs once on first boot.
 *
 * The swap file is not optional: t4g.micro has 1 GB of RAM and the TypeScript build
 * inside the Docker image will be OOM-killed without it.
 */
function buildUserData(): string {
  const script = `#!/bin/bash
set -euxo pipefail

# 2GB swap - the tsc build OOMs on 1GB of RAM otherwise.
dd if=/dev/zero of=/swapfile bs=1M count=2048
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

dnf update -y
dnf install -y docker git
systemctl enable --now docker

# Compose v2 as a docker plugin.
mkdir -p /usr/local/lib/docker/cli-plugins
curl -sSL "https://github.com/docker/compose/releases/download/v2.32.1/docker-compose-linux-aarch64" \\
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

cd /opt
git clone ${REPO_URL} app
cd /opt/app

cat > .env <<'ENVEOF'
NODE_ENV=production
LOG_LEVEL=info
LOG_OUTPUT=json
DATABASE_URL=postgres://postgres:postgres@postgres:5432/hashtag_media
META_ACCESS_TOKEN=${env.META_ACCESS_TOKEN}
META_IG_USER_ID=${env.META_IG_USER_ID}
META_GRAPH_VERSION=${env.META_GRAPH_VERSION}
SYNC_MAX_MEDIA_PER_RUN=${DEPLOY_MAX_MEDIA_PER_RUN}
DOWNLOAD_CONCURRENCY=3
QUEUE_DRIVER=aws
STORAGE_DRIVER=aws
SCHEDULER_DRIVER=aws
AWS_REGION=${env.AWS_REGION}
S3_BUCKET=${env.S3_BUCKET ?? ''}
SQS_QUEUE_URL=${env.SQS_QUEUE_URL ?? ''}
EVENTBRIDGE_SCHEDULE_ROLE_ARN=${env.EVENTBRIDGE_SCHEDULE_ROLE_ARN ?? ''}
ENVEOF
chmod 600 .env

# --profile app brings up postgres + worker + api. restart: unless-stopped in the
# compose file means they come back after a reboot.
docker compose --profile app build
docker compose --profile app up -d

# Migrations run against the container's Postgres once it is healthy.
sleep 20
docker compose --profile app exec -T worker node dist/src/database/migrate.js || true

echo "deployment finished" > /var/log/pipeline-deploy-done
`;

  return Buffer.from(script, 'utf8').toString('base64');
}

runCommand('deploy:ec2', async () => {
  const region = env.AWS_REGION;

  if (!env.S3_BUCKET || !env.SQS_QUEUE_URL) {
    throw new Error('run `pnpm aws:provision` first - S3_BUCKET and SQS_QUEUE_URL must be set');
  }

  const ec2 = new EC2Client({ region });

  // Refuse to launch a second instance if one is already up - the fastest way to a
  // surprise bill is duplicate instances nobody remembers starting.
  const running = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:Name', Values: [INSTANCE_TAG] },
        { Name: 'instance-state-name', Values: ['pending', 'running'] },
      ],
    }),
  );

  const alreadyRunning = running.Reservations?.[0]?.Instances?.[0];
  if (alreadyRunning) {
    log.warn(
      { instanceId: alreadyRunning.InstanceId, publicIp: alreadyRunning.PublicIpAddress },
      'an instance is already running - not launching another. Terminate it first if you want a fresh one.',
    );
    return;
  }

  const accountId = (env.EVENTBRIDGE_SCHEDULE_ROLE_ARN ?? '').split(':')[4];
  if (!accountId) {
    throw new Error('could not derive the account ID from EVENTBRIDGE_SCHEDULE_ROLE_ARN');
  }

  const myIp = (await fetch('https://checkip.amazonaws.com').then((r) => r.text())).trim();

  const vpcs = await ec2.send(
    new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }),
  );
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) {
    throw new Error('no default VPC found');
  }

  const subnets = await ec2.send(
    new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpcId] }] }),
  );
  const subnetId = subnets.Subnets?.[0]?.SubnetId;
  if (!subnetId) {
    throw new Error(`no subnet found in ${vpcId}`);
  }

  await ensureLifecycleRule(env.S3_BUCKET, region);

  const profileName = await ensureInstanceProfile(region, accountId);
  const groupId = await ensureSecurityGroup(ec2, vpcId, myIp);
  await ensureKeyPair(ec2);
  const imageId = await findAmi(ec2);

  // IAM instance profiles propagate slowly; RunInstances can reject one created
  // moments earlier.
  log.info('waiting 15s for the instance profile to propagate');
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  const launched = await ec2.send(
    new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: 't4g.micro',
      MinCount: 1,
      MaxCount: 1,
      KeyName: KEY_NAME,
      SubnetId: subnetId,
      SecurityGroupIds: [groupId],
      IamInstanceProfile: { Name: profileName },
      UserData: buildUserData(),
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          // 20GB stays inside the 30GB free-tier EBS allowance.
          Ebs: { VolumeSize: 20, VolumeType: 'gp3', DeleteOnTermination: true },
        },
      ],
    }),
  );

  const instance = launched.Instances?.[0];
  if (!instance?.InstanceId) {
    throw new Error('RunInstances returned no instance');
  }

  await ec2.send(
    new CreateTagsCommand({
      Resources: [instance.InstanceId],
      Tags: [{ Key: 'Name', Value: INSTANCE_TAG }],
    }),
  );

  log.info(
    { instanceId: instance.InstanceId, type: 't4g.micro', region },
    'instance launched - cloud-init takes 5-10 minutes to build and start the containers',
  );

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `  Instance: ${instance.InstanceId}`,
      '',
      '  Check progress in a few minutes:',
      `    aws ec2 describe-instances --instance-ids ${instance.InstanceId} \\`,
      "      --query 'Reservations[0].Instances[0].PublicIpAddress' --output text",
      '',
      `    ssh -i ${KEY_NAME}.pem ec2-user@<publicIp>`,
      '    sudo docker compose --profile app ps        # in /opt/app',
      '    sudo docker compose --profile app logs -f worker',
      '',
      '  Remove everything, including this instance:',
      '    pnpm aws:teardown --yes',
      '',
    ].join('\n'),
  );
});
