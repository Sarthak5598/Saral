# Design and Implementation Plan

This document is the planning and design record for the Instagram hashtag ingestion
pipeline, written from the sequence of decisions that shaped the build. It covers what
was decided and why, not a step-by-step transcript.

Tool used: **Claude Code (Opus 5)**, used interactively throughout design and
implementation.

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
