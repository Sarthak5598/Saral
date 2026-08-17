# Instructions

Ingestion pipeline for Instagram hashtag media. Fetches `top_media` and
`recent_media` for a tracked hashtag from the Meta Graph API, stores metadata in
Postgres, copies the media files into object storage, deduplicates, and exposes a
paginated read API.

Runs entirely locally by default. Set three environment variables and the same code
runs on SQS, S3 and EventBridge Scheduler.

Diagrams of the flow and every database field: [ai-usage/diagrams.md](ai-usage/diagrams.md).

---

## setup

### The fastest path — local only, no AWS account needed

Six commands, end to end. This is the whole thing running on your machine, against
the real Meta API, with local disk and an in-memory queue standing in for S3 and SQS:

```bash
pnpm install
cp .env.example .env               # then set META_ACCESS_TOKEN
docker compose up -d               # Postgres + Adminer
pnpm db:migrate && pnpm db:seed    # creates the tables, tracks "matcha"
pnpm sync:top matcha               # fetches, dedupes, downloads - the whole pipeline
pnpm dev                           # starts the API on :3000
```

Then:

```bash
curl "http://localhost:3000/hashtags?limit=5"
```

That is the complete local path. Everything below covers configuration options,
deeper verification, and the AWS deployment — none of it is required to see the
pipeline run.

### Prerequisites

- Node.js 22+
- pnpm (`corepack enable`)
- Docker Desktop

### 1. Install and configure

```bash
pnpm install
cp .env.example .env
```

Edit `.env` and set `META_ACCESS_TOKEN` to the Instagram page token. Everything else
has a working default.

### 2. Start Postgres

```bash
docker compose up -d
```

This starts two containers:

| Service  | URL                     | Credentials                        |
| -------- | ----------------------- | ---------------------------------- |
| Postgres | `localhost:5434`        | `postgres` / `postgres`            |
| Adminer  | http://localhost:8081   | server `postgres`, user/pass as above |

Postgres is published on **5434**, not the usual 5432 or 5433. Both of those were
already bound on the development machine by a native Postgres install which won the
bind race — connections silently reached the wrong server while Docker still
reported the container healthy. If 5434 is taken on your machine, change the port in
`docker-compose.yml` and `DATABASE_URL` together.

### 3. Migrate and seed

```bash
pnpm db:migrate
pnpm db:seed
```

`db:seed` inserts `matcha` as a tracked hashtag. Nothing in the code hardcodes it —
it is a row, and the scheduler reads from the table.

### 4. Run it

Fastest way to see the whole pipeline work, end to end, in one command:

```bash
pnpm sync:top matcha
```

That resolves the hashtag ID, walks every page of `top_media` up to the 500-item cap,
writes the raw payloads and curated rows, then downloads and stores every media file.
Expect it to take a few minutes — Meta's hashtag edges respond in roughly 8 seconds
per page (see [tradeoffs](#tradeoffs)).

Then start the API and read the data back:

```bash
pnpm dev
curl "http://localhost:3000/hashtags?limit=5"
```

### 5. Long-running mode

For the scheduled 3-hourly behaviour, run the worker in a second terminal:

```bash
pnpm dev          # API on :3000
pnpm dev:worker   # cron + job consumer
```

Under `SCHEDULER_DRIVER=local` the worker owns an in-process cron, so the schedule
only fires while it is running. Under `aws`, EventBridge fires regardless.

### Verifying it works

A reviewer can confirm the whole system in about ten minutes. Nothing here waits for
the three-hour schedule.

**1. Static checks**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

**2. Local drivers, end to end.** With `QUEUE_DRIVER`/`STORAGE_DRIVER`/
`SCHEDULER_DRIVER` all `local`:

```bash
pnpm sync:top matcha
ls -R storage/media | head          # downloaded files, keyed by sha256
```

**3. Deduplication.** Run the same sync twice and compare `items_new`:

```bash
pnpm sync:recent matcha
pnpm sync:recent matcha
```

```sql
SELECT type, items_seen, items_new, pages_fetched, status
FROM sync_runs ORDER BY started_at;
```

The second run should report `items_seen` well above `items_new` — those are duplicates
the `UNIQUE(ig_media_id)` constraint absorbed.

**4. The metric time series.** Proof that repeated syncs accumulate history rather
than overwriting it:

```sql
SELECT m.ig_media_id, count(*) AS observations,
       min(s.like_count) AS first, max(s.like_count) AS latest
FROM media_post_history s JOIN media_posts m ON m.id = s.media_id
GROUP BY m.ig_media_id HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 5;
```

**5. The read API.**

```bash
pnpm dev
curl "http://localhost:3000/hashtags?limit=3"
curl "http://localhost:3000/hashtags?limit=3&cursor=<nextCursor>"
curl -i "http://localhost:3000/hashtags?limit=999"      # 400
curl -i "http://localhost:3000/hashtags?hashtag=nope"   # 404
curl "http://localhost:3000/health"
```

**6. Replay from the raw layer**, spending no API quota:

```bash
pnpm replay <a sync_run_id from step 3>
```

**7. AWS drivers.** After `pnpm aws:provision`, set the three drivers to `aws`, then:

```bash
pnpm sync:recent matcha
aws s3 ls s3://<bucket>/media/ --recursive --summarize | tail -3
```

**8. The scheduled path**, without waiting three hours. Create a temporary
fast-firing schedule against the same target, watch SQS receive it, then delete it:

```bash
aws scheduler create-schedule --name probe --schedule-expression "rate(2 minutes)" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target "{\"Arn\":\"<queueArn>\",\"RoleArn\":\"<roleArn>\",\"Input\":\"{\\\"type\\\":\\\"DISPATCH_DUE_SYNCS\\\",\\\"kind\\\":\\\"recent\\\"}\"}"

aws sqs receive-message --queue-url <queueUrl> --wait-time-seconds 20
aws scheduler delete-schedule --name probe
```

Verified during development: the message arrived in 40 seconds as
`{"type":"DISPATCH_DUE_SYNCS","kind":"recent"}`.

**9. The worker consuming it.** Run `pnpm dev:worker` and it long-polls SQS, picks up
that dispatch message, fans out one sync job per active hashtag, and drains the asset
downloads.

### Commands

| Command                        | What it does                                                     |
| ------------------------------ | ---------------------------------------------------------------- |
| `pnpm dev`                     | API with reload                                                  |
| `pnpm dev:worker`              | Job consumer + local cron                                        |
| `pnpm db:migrate`              | Apply migrations                                                 |
| `pnpm db:seed`                 | Track `matcha` (idempotent)                                      |
| `pnpm db:generate`             | Generate a new migration from schema changes                     |
| `pnpm hashtag:track <name>`    | Track a hashtag, resolve its ID, queue an initial top sync        |
| `pnpm hashtag:untrack <name>`  | Deactivate a hashtag, keeping all collected data                  |
| `pnpm sync:top <name>`         | Run a top-media sync inline and drain asset downloads             |
| `pnpm sync:recent [name]`      | Same for recent media; no argument means all due hashtags         |
| `pnpm replay <sync_run_id>`    | Rebuild curated tables from raw payloads, spending zero API quota |
| `pnpm aws:provision`           | Create the S3 bucket, SQS queues, IAM role and schedule           |
| `pnpm test`                    | 46 unit tests                                                    |
| `pnpm lint` / `pnpm typecheck` | ESLint / tsc                                                     |

### Tracking a different hashtag

No code change and no redeploy:

```bash
pnpm hashtag:track coffee
pnpm hashtag:track pilates 2026-09-01 2026-09-30   # optional tracking window
```

The scheduler selects `WHERE is_active AND now() BETWEEN track_from AND track_until`,
so adding a tag is an insert. The optional dates gate **when we sync**, deliberately
not which posts are kept — discarding media already paid for in API quota would be
unrecoverable. Filtering posts by age is a read concern: `?takenAfter=`.

A CLI command rather than a `POST /hashtags` endpoint because the brief specifies one
paginated API.

**Constraint:** Meta allows 30 **unique** hashtags per rolling 7 days
per Instagram account. Re-syncing an already-queried tag is free within that window,
but the 31st new tag in a week will fail.

### AWS deployment

The same code runs unmodified against SQS, S3, and EventBridge Scheduler by setting
`QUEUE_DRIVER=aws`, `STORAGE_DRIVER=aws`, and `SCHEDULER_DRIVER=aws`, backed by two
scripts:

```bash
pnpm aws:provision   # creates the S3 bucket, SQS queue + DLQ, IAM role, EventBridge schedule
pnpm deploy:ec2      # launches an EC2 instance running the full stack in Docker
pnpm aws:teardown --yes   # removes all of it, instance first
```

These authenticate using whatever AWS credentials are configured on the machine
running them (`aws configure`) and provision resources in **that** account — there is
no way to reach the author's deployment without the author's own credentials, which
are not distributed with this repository. Running these commands against a reviewer's
own AWS account creates an independent copy of the deployment for evaluation.

The author's own AWS deployment — its design, the constraints that shaped it (no
Lambda, no RDS, EC2 cost controls), and verification that it runs correctly and
unattended — is documented in full in
[ai-usage/design-and-implementation-plan.md](ai-usage/design-and-implementation-plan.md),
including a recorded walkthrough. `pnpm aws:teardown` terminates the instance first
and logs loudly if it cannot, since a running instance is the one resource here that
costs money per hour.

### API

`GET /hashtags` — stored media, newest post first, keyset-paginated. Also served at
`/api/v1/hashtags`.

| Parameter      | Default | Notes                                   |
| -------------- | ------- | --------------------------------------- |
| `hashtag`      | all     | name without `#`; 404 if not tracked    |
| `limit`        | 25      | 1–100                                   |
| `cursor`       | —       | opaque, from a previous `nextCursor`     |
| `mediaType`    | all     | `IMAGE` \| `VIDEO` \| `CAROUSEL_ALBUM`   |
| `takenAfter`   | —       | ISO date, filters on the post's own time |
| `takenBefore`  | —       | ISO date                                 |
| `includeStale` | `true`  | include posts that stopped appearing     |
| `includeAsset` | `true`  | include stored-asset details             |

Paginate until `nextCursor` is `null`:

```bash
curl "http://localhost:3000/hashtags?hashtag=matcha&limit=10"
curl "http://localhost:3000/hashtags?limit=10&cursor=<nextCursor>"
```

---

## vars

| Variable                        | Default                   | Purpose                                                        |
| ------------------------------- | ------------------------- | -------------------------------------------------------------- |
| `NODE_ENV`                      | `development`             |                                                                |
| `APP_PORT`                      | `3000`                    | API port                                                       |
| `APP_ROUTE_PREFIX`              | `/api/v1`                 | Secondary mount for the API                                    |
| `LOG_LEVEL`                     | `info`                    | `trace`…`fatal`                                                |
| `LOG_OUTPUT`                    | `json`                    | `dev` for human-readable                                       |
| `DATABASE_URL`                  | localhost:5434            | **The only change needed to move to RDS**                      |
| `DATABASE_POOL_MAX`             | `10`                      | Pool size                                                      |
| `META_ACCESS_TOKEN`             | — **(required)**          | Instagram page token                                           |
| `META_IG_USER_ID`               | `17841480695597364`       | Business account ID                                            |
| `META_GRAPH_VERSION`            | `v24.0`                   | Graph API version                                              |
| `META_API_BASE_URL`             | graph.facebook.com        | Override for testing                                           |
| `SYNC_MAX_MEDIA_PER_RUN`        | `500`                     | Hard cap per sync, per the brief                               |
| `SYNC_PAGE_SIZE`                | `25`                      | Upper bound only — the client negotiates down (see tradeoffs)  |
| `DOWNLOAD_CONCURRENCY`          | `5`                       | Worker concurrency                                             |
| `META_THROTTLE_THRESHOLD_PCT`   | `80`                      | Back off above this share of the rate-limit budget             |
| `META_REQUEST_TIMEOUT_MS`       | `60000`                   | Generous — these edges are slow                                |
| `QUEUE_DRIVER`                  | `local`                   | `local` \| `aws`                                               |
| `STORAGE_DRIVER`                | `local`                   | `local` \| `aws`                                               |
| `SCHEDULER_DRIVER`              | `local`                   | `local` \| `aws`                                               |
| `LOCAL_STORAGE_DIR`             | `./storage`               | Local driver output                                            |
| `RECENT_SYNC_CRON`              | `0 */3 * * *`             | Unix 5-field; translated for EventBridge                       |
| `AWS_REGION`                    | `eu-west-2`               |                                                                |
| `S3_BUCKET`                     | —                         | Required when `STORAGE_DRIVER=aws`                             |
| `SQS_QUEUE_URL`                 | —                         | Required when `QUEUE_DRIVER=aws`                               |
| `SQS_DLQ_URL`                   | —                         | Informational                                                  |
| `SQS_VISIBILITY_TIMEOUT`        | `300`                     | Must exceed worst-case job time; the worker heartbeats         |
| `SQS_WAIT_TIME_SECONDS`         | `20`                      | Long polling — see the short-polling note in tradeoffs         |
| `EVENTBRIDGE_SCHEDULE_NAME`     | `sync-recent-hashtag-media` |                                                              |
| `EVENTBRIDGE_SCHEDULE_ROLE_ARN` | —                         | Required when `SCHEDULER_DRIVER=aws`                           |

Configuration is validated by Zod at boot, and the process refuses to start on bad
input. That is deliberate: the worst failure mode available here is a misconfigured
pipeline that starts cleanly and then logs "0 items synced" every three hours.

---

## tradeoffs

### Meta's API does not behave as documented

Three findings from probing v24.0 directly, each of which changed the design.

**The page-size limit is far below the documented 50, and varies.** `top_media`
rejected `limit=10`; `recent_media` rejected `limit=25`. It is not field-dependent —
`fields=id` alone at `limit=25` fails. Worse, the ceiling moves: 6 was accepted on one
run and rejected on the next. So `SYNC_PAGE_SIZE` is an upper bound and the client
negotiates downward until Meta accepts, remembers what worked, and probes upward again
on later runs. A downward-only ratchet would decay a long-lived worker to `limit=1`
permanently.

**Meta reports that error as HTTP 500.** A client-side problem arrives as a server
fault, so status-based retry classification is actively wrong: the first
implementation blind-retried the identical doomed request four times. Classification
happens on the Graph error code before the HTTP status. A regression test covers it.

**The edges are slow.** ~8 seconds per page. Combined with ~6 items per page, a full
500-item sync is roughly 83 requests over ~11 minutes. This is why the work belongs
in a queue rather than a web request, why the request timeout is 60s, and why sync
runs are resumable.

### Kept, and why

- **A raw landing layer** (`data_points`, append-only JSONB). Normally
  optional; close to essential here, because two constraints make re-fetching
  impossible rather than merely expensive: the 30-unique-hashtags-per-7-days quota
  cannot be topped up, and `media_url` expires within days. Without it, a parsing bug
  found on Friday loses Tuesday's data permanently. `pnpm replay` rebuilds the curated
  tables from it with zero API calls.
- **Metric snapshots instead of overwriting.** `like_count` is an observation, not an
  attribute. A post at 594 likes today and 1,200 next week is information —
  engagement velocity, what is trending — and `UPDATE` destroys it. Growth is bounded:
  ~4k rows/day, a natural candidate for monthly partitioning if it ever mattered.
- **Content-addressed storage.** Keys are `media/<ab>/<cd>/<sha256>.<ext>`, the same
  scheme git uses. Two different posts can be byte-identical, so this stores reposts
  once and makes repost clusters queryable as rows sharing a `sha256`.
- **Four distinct timestamps** on `media_posts`: `taken_at`, `first_seen_at`,
  `last_seen_at`, `content_updated_at`. The last is bumped only when the caption,
  permalink or type actually changed — setting `updated_at = now()` on every sync
  makes every row look freshly edited when nothing happened.
- **Advisory locks** per hashtag + kind, so a manual `pnpm sync:recent` cannot race
  the scheduled run and double-spend quota. Non-blocking: it skips rather than tying
  up a worker for eleven minutes.
- **A Queue interface modelled on SQS, not on the in-memory driver.** The constraint
  only runs one way — code written against a perfect in-process queue breaks on SQS.
  So `InMemoryQueue` emulates visibility timeouts, fresh receipt handles per delivery,
  `receivedCount`, and a `maxReceiveCount` ceiling feeding a local DLQ.

### Deliberately not built

- **Hosting.** The brief asks for code plus setup instructions, so nothing is
  deployed. Postgres stays in Docker specifically so a reviewer can run this without
  our credentials. RDS would make the submission unrunnable.
- **Lambda.** EventBridge Scheduler targets SQS directly. A Lambda would need network
  access to Postgres, forcing RDS and VPC configuration the assignment does not need.
- **Presigned URLs / media serving.** `asset.locator` returns `s3://bucket/key`, not
  an HTTPS URL. The bucket is private — this is other people's copyrighted content, and
  a public bucket would be an open CDN with unbounded egress. A returned `https://` URL
  that 403s for every caller is worse than an honest URI. The extension point would be
  `GET /hashtags/:id/asset` presigning and redirecting.
- **Write endpoints.** Tracking a hashtag is a CLI command, because the brief
  specifies one paginated API.
- **Carousel children.** `children` is rejected by this edge (verified), so a
  `CAROUSEL_ALBUM` yields one cover image and one file per post.
- **Auth, CI, Swagger, a frontend.** Out of scope for a brief that states
  production-readiness is not expected.
- **PollyJS** for HTTP record/replay. The 46 tests stub `fetch` against recorded
  response shapes, which achieves the same isolation without a dependency. Worth
  revisiting if the API surface grew beyond three endpoints.

### Known limitations

- **Owner and location data are unavailable.** Hashtag search returns only `id`,
  `caption`, `media_type`, `media_url`, `permalink`, `timestamp`, `like_count`,
  `comments_count`. No username, follower count, or place — Meta strips these for
  media on accounts you do not own. The caption is therefore the only enrichment
  surface, parsed into `caption arrays on media_posts` for hashtag co-occurrence and
  mentions. Those values are **derived, not authoritative**: `#kyoto` is a soft
  geographic hint, never a location field.
- **The access token will expire.** When it does, Meta returns Graph code 190. That
  path is deliberately terminal and logged at `fatal`, because an auth failure that
  degrades into "0 items synced" is indistinguishable from "no new posts".
- **Under `SCHEDULER_DRIVER=local` the cron only fires while the worker runs**, and
  the in-memory queue dies with the process. This is the main argument for the AWS
  drivers.
- **Stale detection is a flag, not a fact.** A post can vanish because it was deleted,
  made private, or simply fell out of the top set; we cannot distinguish those, so
  `is_stale` is soft and nothing is ever hard-deleted.
- **The learned page size is per-process.** It resets on restart, costing one or two
  probe requests. Persisting it was judged not worth a schema column for a value that
  is a property of Meta's current mood rather than of our data.
- **Tests do not cover the AWS adapters against real AWS.** They were verified
  manually end to end (see below); automated coverage would need LocalStack.

### Verified end to end

Against the live Meta API and a real AWS account, not only typechecked:

```
run 1  top_media     4 pages  24 items  24 new
run 2  recent_media  1 page   12 items  12 new
run 3  recent_media  1 page   12 items   4 new   <- 8 duplicates deduped
```

40 unique media, 48 snapshots, 48 raw rows, 14 objects in S3. One post's metric
history moved 3 → 6 likes across runs. Paginating `GET /hashtags` at `limit=7` took 6
pages and returned 40 items with 0 duplicates and complete coverage, strictly
descending. `pnpm replay` reprocessed 24 items with zero API calls.

Two bugs surfaced only by running it for real:

1. **SQS short polling.** With `WaitTimeSeconds=0`, SQS samples a subset of its
   servers and can return empty while the queue is not — the drain loop declared
   itself finished and abandoned 4 messages. It now long-polls and requires several
   consecutive empty responses.
2. **Non-Latin hashtags were truncated.** Thai, Arabic and Devanagari compose
   characters from a base letter plus combining marks, so `#มัทฉะ` matched only `ม`.
   Every hashtag in those scripts was silently reduced to one character. Fixed by
   adding `\p{M}`; regression tests cover Thai, Arabic, Japanese and accented Latin.

---

## ai-usage

**See [ai-usage/design-and-implementation-plan.md](ai-usage/design-and-implementation-plan.md)**
for the full design and planning record — the sequence of architectural decisions
(raw/curated split, ports and adapters, deduplication, deployment shape, pagination
strategy) and why each was made.

**See [ai-usage/verify-aws-deployment.md](ai-usage/verify-aws-deployment.md)** for how
to confirm the AWS deployment is real and currently running, including what was tested
end-to-end during development.

### Tools

**Claude Code (Opus 5)** was the only AI tool used, driven interactively through the
whole build.

### What it was used for

- **Design discussion.** Iterating on the data model — the raw/curated split, whether
  metrics should be overwritten or appended, what the timestamp columns should mean,
  what to do about the missing owner/location fields. Several decisions in
  [tradeoffs](#tradeoffs) came out of that back-and-forth rather than arriving
  fully-formed.
- **Writing the implementation**, including the schema and migrations, the Meta client,
  the ports/adapters layer, the ingestion services, the read API and the tests.
- **Probing the live API** to establish real behaviour instead of trusting the docs.
  This produced the three findings above about page limits, HTTP 500 misreporting, and
  latency — none of which are documented.
- **Debugging.** The busy-wait in `JobRunner`, the SQS short-polling bug, the
  combining-marks bug in the caption parser, and a Postgres port conflict where a
  native install had won the bind race against Docker.
- **Writing the AWS provisioning script** and running it against the account.

### What was reviewed and verified

Every non-trivial claim in this document was checked by running it, not by reading
code:

- Migrations applied against real Postgres, then the dedupe constraint tested directly
  in `psql` — a repeated `ig_media_id` collapsing to one row, and a blind insert being
  rejected by the database rather than by application logic.
- Meta's page-size ceiling established by sweeping `limit` values and field
  combinations with `curl` until the failure boundary was clear.
- The full pipeline run three times against the live API, with row counts, dedupe
  behaviour and metric history verified in SQL afterwards.
- `GET /hashtags` paginated exhaustively and checked for duplicates, gaps and ordering;
  every error path exercised for its status code.
- S3 objects confirmed present via `aws s3 ls` and `head-object`; the EventBridge
  schedule confirmed `ENABLED` with the right target and role.
- The `?` requirement in EventBridge cron expressions confirmed empirically by
  submitting all four day-field combinations and recording which AWS accepts.

### Where AI got it wrong

Worth recording, since it is the honest part of the answer:

- The first pass at the page-size fix **did not work**, because the retry logic
  classified Meta's HTTP 500 as transient and never reached the code-1 handler. It took
  actually running it to see that.
- The `JobRunner` poll loop shipped with a busy-wait that killed the test worker after
  96 seconds and would have pegged a CPU core in production.
- The learned-page-size cache initially only ratcheted downward, which would have
  decayed a long-running worker to `limit=1` permanently.
- The SQS drain loop used short polling and silently abandoned messages.

All four were found by running the system rather than by inspection, which is the
pattern: AI-written code compiled and looked correct while being wrong in ways only
execution exposed.
