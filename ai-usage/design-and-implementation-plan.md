# Design and Implementation Plan

This document is the planning and design record for the Instagram hashtag ingestion
pipeline, written from the sequence of decisions that shaped the build. It covers what
was decided and why, not a step-by-step transcript.

Tool used: **Claude Code (Opus 5)**, used interactively throughout design and
implementation.

---

## How the work was actually done

The shape of the process, roughly in order:

**Scoping.** Started by walking through the brief line by line — what Express + TS +
Postgres actually implies for structure, what "avoid duplicate media records" requires
at the database level rather than the application level, and what "up to 500 media
items per sync" means for pagination and rate limits before writing anything. Part of
this stage was identifying what I did *not* yet understand well enough to design
around — Meta's actual hashtag API behaviour under load, SQS's delivery guarantees, and
what EventBridge Scheduler can and cannot target directly. Those became the things to
get concrete answers on, by probing the live API and reading the AWS documentation
next to the code, rather than assuming.

**Design — the tables, and what belongs in each.** This was the largest single piece
of back-and-forth: given the brief explicitly invites keeping or dropping the suggested
fields, working through what data actually needs to exist, in which table, and why a
given table is separate from another rather than merged into it. That meant asking
questions like: does a metrics history table need its own row every sync, or only on
change? Does the downloaded file's status belong on the post row, or its own table? Does
a caption's hashtags need a join table, or can they live as an array on the post? Each
of those was worked through against a concrete failure case (what breaks if this is
merged, what breaks if this is split) rather than a general rule, which is why the final
schema doesn't match the brief's suggested field list exactly.

**Making sure it scales.** Once the shape of the data was settled, the next pass was
about what happens under real, repeated load rather than a single test run: what a
table looks like after 8 syncs a day for a year, whether repeated `UPDATE`s on a
frequently-read table cause problems Postgres has to work around (they do — MVCC row
rewrites), and where a database constraint has to do the job instead of application
logic because two things can happen at once (the unique constraint on the post ID,
which has to hold even if two workers process the same message simultaneously).

**Concurrency and ordering — does downloading a file block anything else?** This came
up directly: if fetching page 2 of results has to wait for page 1's images to finish
downloading, a slow or failing download would stall the whole sync. The answer worked
through was to treat "fetch and record metadata" and "download and store the file" as
two separate jobs on a queue rather than one sequential piece of work — so a single
broken video retries on its own without blocking the other 99 posts in that page, and
without blocking the next page's own metadata write. That distinction — what has to stay
inside one transaction because it must be consistent, versus what is safe to hand off to
an independent, retryable job — is what section 5 below is about.

---

## 1. Reading the brief

The brief asks for four things end to end: fetch from Meta, store in Postgres, upload
assets to storage, avoid duplicates, expose one paginated API — with local
implementations swappable for AWS ones. Two constraints shaped the whole design before
any code was written:

- Meta's hashtag endpoints allow only **30 unique hashtags per rolling 7 days** per
  Instagram account. There is no "just re-fetch it."
- Meta's `media_url` is a **signed, expiring link**. It is not a durable reference to
  the media.

Both of these mean that a mistake in ingestion cannot be undone by asking Meta again.
That single fact drove several structural decisions below.

## 2. Architecture decision: raw layer + curated layer

**Plan:** rather than one table of "media we've seen," split storage into two layers —
an append-only raw layer holding exactly what Meta returned, and a curated layer holding
one deduplicated row per post.

**Reasoning:** given the two constraints above, a parsing bug discovered after the fact
would otherwise be unrecoverable — the API can't be re-queried and the media links have
expired. Keeping the raw JSONB response means the curated tables can be rebuilt from
history with zero API calls. This became the `data_points` → `media_posts` split, and
the `pnpm replay` command that rebuilds curated data from raw.

## 3. Architecture decision: ports and adapters for Queue/Storage/Scheduler

**Plan:** define three interfaces — `Queue`, `Storage`, `Scheduler` — with a local
implementation (in-memory queue, disk storage, node-cron) and an AWS implementation
(SQS, S3, EventBridge Scheduler) behind each, selected by three independent environment
variables.

**Reasoning:** the brief requires the local setup to be replaceable by AWS without
rewriting business logic. The interfaces were modelled on SQS's actual semantics
(receipt handles, visibility timeouts, at-least-once delivery) rather than on the easier
in-memory case, so that code written against the local driver would behave correctly
against SQS rather than merely compile against it. This was a deliberate choice: the
constraint only runs one direction, and the in-memory queue was written to enforce it
(invisibility windows, redelivery counters, a local dead-letter queue).

## 4. Schema design: what to keep, what to drop, what to add

The brief asks explicitly what to keep or drop from the suggested field list, and to
justify it. The plan:

- **Keep** everything Meta actually returns for hashtag media (verified against the live
  API — hashtag search does not return owner, location, or follower data at all, so
  those were never options).
- **Add** an append-only history table for engagement metrics rather than overwriting a
  single `like_count` column, because a single column cannot represent "594 likes
  yesterday, 1,200 today" — that is a time series, not a fact.
- **Add** content-addressed storage for downloaded files (key = sha256 of the bytes),
  because the same image can appear as a repost under a different post ID, and hashing
  means it is stored once regardless.
- **Drop** a separate join table for caption hashtags/mentions in favour of array
  columns on the post itself, once the shape of the problem was clear: Instagram caps a
  caption at 30 hashtags, so the list is small and bounded, and the tags belong to the
  post rather than to a measurement of it.
- **Iterate on naming and structure** after initial implementation: the metrics history
  table was redesigned to store the full state of a post (not metrics alone) each time
  something about it changed, changing only when a value actually differs from the
  previous observation rather than on every sync. This was a deliberate refinement
  during review, not part of the original plan — the initial version recorded a metrics
  row on every sync regardless of change, which would have meant far more rows than
  necessary for a low-value gain.

## 5. Ingestion design: page-loop ordering

**Plan:** within one sync, order the writes per page as: (1) raw response, (2)
deduplicated post + history if changed, (3) create a pending asset record and enqueue
its download, (4) save the pagination cursor — in that order, and only advance the
cursor after a page's data is fully written.

**Reasoning:** this ordering is what makes a crash recoverable rather than destructive.
Writing raw first means an unexpected shape in a later step doesn't lose the response.
Writing the cursor last, after everything else for that page succeeded, means a resumed
run starts from the last complete page rather than re-doing work or skipping data.

## 6. Deduplication design

**Plan:** enforce uniqueness with a database constraint (`UNIQUE(ig_media_id)`) and an
`INSERT ... ON CONFLICT DO UPDATE`, rather than a "check if it exists, then insert" pattern
in application code.

**Reasoning:** SQS delivers at-least-once by design, so the same item can legitimately
be processed twice. A check-then-insert pattern has a race condition under concurrent
processing; a database constraint does not. This was treated as a correctness
requirement rather than an optimisation.

## 7. Queue-worker design: visibility and heartbeat

**Plan:** the worker polls SQS with long polling (`WaitTimeSeconds: 20`) rather than
short polling, and extends a message's visibility timeout while a job is still running.

**Reasoning:** long polling avoids wasteful constant polling while still picking up new
work within roughly the request's open window. The visibility extension exists because
a single sync can take longer than SQS's default invisibility window — without
extending it, SQS would consider the worker dead and redeliver the same job to a second
worker mid-run, doubling the work and the API calls spent.

## 8. Local-first, AWS-second sequencing

**Plan:** build and fully verify the pipeline against local drivers first (in-memory
queue, disk storage, local cron) before wiring up AWS, and keep both driver sets
working rather than treating the local one as scaffolding to be discarded.

**Reasoning:** this let every piece of business logic be tested without depending on
AWS credentials or provisioning, and meant AWS integration was a matter of writing
adapters against an already-correct interface rather than debugging business logic and
infrastructure at the same time. Both driver sets remain in the final code, selected
by environment variable, per the brief's requirement.

## 9. Deployment design: EventBridge → SQS, no Lambda; single EC2 instance, no RDS

**Plan:** for the optional "runs unattended in AWS" deployment, use EventBridge
Scheduler targeting SQS directly (no Lambda in between), and run the worker and
Postgres together on a single small EC2 instance (no RDS).

**Reasoning:** a Lambda-based design would need network access to Postgres, which would
require RDS and VPC configuration well beyond the scope of a hashtag ingestion
assignment. A single instance keeps the deployment inside AWS's free tier and keeps
reviewers able to run the whole system locally without needing our AWS account —
Postgres in Docker rather than a managed database was a deliberate choice so the
submission stays runnable by anyone who clones the repo.

## 10. Read API design: keyset pagination, not offset

**Plan:** paginate `GET /hashtags` using a keyset cursor on `(taken_at, id)` rather than
`OFFSET`/`LIMIT`.

**Reasoning:** the underlying table is written to continuously (new syncs every three
hours), and offset pagination shifts under concurrent writes — a page boundary computed
against row *position* is not stable when rows are being inserted between requests. A
keyset cursor anchored to an indexed, monotonic column pair does not have this problem.
`id` was added as a tiebreaker because Instagram timestamps are not guaranteed unique.

## 11. Interpreting an ambiguous requirement

The brief asks for results in "descending order of creation time." This was read as the
post's own creation time on Instagram (`taken_at`), not the time our system first
observed it (`first_seen_at`) — because a `top_media` sync can surface posts that are
weeks old, and ordering by observation time would interleave old and new posts in a way
that does not match what "creation time" means for the underlying content. Both
timestamps are exposed in the API response so a consumer can choose otherwise if their
definition differs.

---

## What was reviewed and verified, not just planned

Every design decision above was checked against a running system before being
considered final:

- The database schema was verified against real data returned by the Meta API, not
  synthetic fixtures — including checking exactly which fields Meta returns and does
  not return.
- The deduplication constraint was verified by intentionally provoking the conflict
  case and confirming database-level rejection, not just testing the happy path.
- Pagination was verified by walking a full result set and checking for gaps or
  duplicates against the total count.
- The queue/worker interaction (visibility timeout, redelivery, dead-letter behaviour)
  was verified with deliberately-failing jobs, not assumed from the SDK documentation.
- The AWS deployment was verified end-to-end: a message was sent to the live queue and
  confirmed to be picked up and processed by the deployed worker, writing to the
  deployed database and the real S3 bucket.

Design changes made after implementation began (notably the metrics-history redesign
in section 4) were driven by that verification process — reviewing what the running
system actually produced and revising the schema when the first design did not hold up
under real data volume.

---

## Verifying the AWS deployment

The pipeline also runs unattended in AWS: EventBridge Scheduler fires every 3 hours,
drops a message on SQS, and a worker on a small EC2 instance picks it up, syncs
Instagram media, and writes to its own Postgres and S3 bucket — independent of anyone's
laptop. Three resources make that true regardless of whether a developer's machine is
on:

| Resource | What it does |
| --- | --- |
| EventBridge Scheduler | fires `cron(0 */3 * * ? *)` — every 3 hours, UTC |
| SQS queue + dead-letter queue | receives the fired event, holds it until a worker reads it |
| EC2 instance (worker + Postgres + API in Docker) | reads the queue, does the sync, writes to its own database and to S3 |

The instance deliberately exposes nothing but SSH, and only from one IP — this is a
private database holding third-party content pulled from a public API, not a public
service, so it is not left open for review. Proof of the deployment working is instead
a recorded walkthrough: the schedule confirmed `ENABLED`, the instance confirmed running
with its real launch time (not spun up for the recording), a message sent to the live
SQS queue on camera, the deployed worker's own logs reacting to it in real time, and a
row count against the deployed database increasing right after.

This was also genuinely exercised during development, not only at the end:

- A message was manually sent to the live SQS queue and confirmed to arrive and be
  processed by the deployed worker — writing real rows to Postgres and real files to S3
  within seconds.
- A short-lived test schedule (`rate(2 minutes)`, since replaced by the real 3-hourly
  one) confirmed EventBridge actually delivers into SQS without waiting for a real
  3-hour boundary.
- The deployment was rebuilt from scratch on the instance at least twice after fixing
  real bugs (a package-manager version mismatch between local and Docker, and a
  compiled-output path issue), so what runs now reflects a working build, not the first
  attempt.

None of this needs to be trusted blindly — the deployment is scripted and reproducible
against any AWS account:

```bash
pnpm aws:provision   # S3 bucket, SQS queue + DLQ, IAM role, EventBridge schedule
pnpm deploy:ec2      # launches the EC2 instance, starts the containers via cloud-init
pnpm aws:teardown --yes   # tears all of it back down, instance first
```
