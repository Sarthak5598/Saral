# Verifying the AWS Deployment

The pipeline runs unattended in AWS: EventBridge Scheduler fires every 3 hours, drops a
message on SQS, and a worker on a small EC2 instance picks it up, syncs Instagram media,
and writes to its own Postgres and S3 bucket — independent of anyone's laptop.

This is how to check that it is real and currently running, without needing our AWS
account.

---

## 1. See it running, no AWS access needed

**The public API is not exposed** — the deployed instance only accepts SSH, and only
from one IP, on purpose (this is a private database holding third-party content, not a
public service). So checking it means either being granted temporary access, or trusting
the evidence below and in `instructions.md`.

If you want hands-on access to confirm it yourselves, ask and we can:
- Temporarily open the API port to your IP so you can hit `GET /hashtags` directly
  against the deployed database, or
- Share SSH access to inspect the running containers and logs directly

## 2. What "running unattended" means, concretely

Three AWS resources exist independently of any laptop:

| Resource | What it does | How to picture it |
|---|---|---|
| **EventBridge Scheduler** | fires `cron(0 */3 * * ? *)` — every 3 hours, UTC | an alarm clock that keeps ringing whether or not anyone is home |
| **SQS queue + dead-letter queue** | receives the fired event, holds it until a worker reads it | a mailbox that doesn't need anyone watching it |
| **EC2 instance running the worker + Postgres + API in Docker** | reads the queue, does the actual sync, writes to its own database and to S3 | the only "always-on" compute involved |

None of this depends on a developer's machine. The scheduler fires regardless; the
queue holds messages for up to 14 days if nothing is consuming them; the EC2 instance
runs continuously.

## 3. Proof this was tested for real, not just deployed

During development, the AWS path was deliberately exercised end-to-end rather than
assumed to work from the SDK documentation:

- **A message was manually sent to the live SQS queue** and confirmed to arrive and be
  processed by the deployed worker — writing real rows to the deployed Postgres and
  real files to the deployed S3 bucket, within seconds of being sent.
- **A short-lived test schedule** (`rate(2 minutes)`, since replaced by the real
  3-hourly one) was created to confirm EventBridge actually delivers into SQS without
  waiting for a real 3-hour boundary — delivery was observed in well under a minute.
- **The deployment was rebuilt from scratch on the EC2 instance** at least twice during
  development after fixing real bugs (a package-manager version mismatch between local
  and Docker, and a compiled-output path issue), so what is running now reflects a
  working build, not the first attempt.

## 4. How to check it yourself, if given credentials

If temporary AWS console read access is provided:

- **CloudWatch / EC2 console** — confirm the instance is `running`, note its uptime.
- **EventBridge Scheduler console** — confirm the schedule is `ENABLED` with expression
  `cron(0 */3 * * ? *)`, and check "Next invocation time."
- **SQS console** — confirm the queue and its dead-letter queue exist; queue depth
  should normally sit at 0 or briefly rise right after a scheduled firing, since the
  worker drains it quickly.
- **S3 console** — browse the bucket; objects are keyed as
  `media/<first-2-hex>/<next-2-hex>/<full-sha256>.<ext>` and have a 7-day expiry
  lifecycle rule applied (visible under the bucket's Management tab).

## 5. Reproducing the whole thing independently

Nothing above needs to be trusted blindly — the full deployment is scripted and
reproducible from the repo, using your own AWS account:

```bash
pnpm aws:provision   # creates the S3 bucket, SQS queue + DLQ, IAM role, EventBridge schedule
pnpm deploy:ec2      # launches the EC2 instance and starts the containers via cloud-init
```

Both commands are idempotent and print exactly what they created. `instructions.md`
covers the full local setup and testing steps, including how to exercise the local
in-memory/disk equivalents of every AWS piece without needing any cloud account at all.

## 6. Tearing it down

When finished reviewing, everything AWS-side can be removed with one command (costs
nothing to leave running either, since it sits inside AWS's free tier, but this is
provided for completeness):

```bash
pnpm aws:teardown --yes
```

This terminates the EC2 instance first — the only resource billed per hour — then
removes the schedule, queues, IAM role, and empties and deletes the S3 bucket.
