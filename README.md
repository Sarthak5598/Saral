# Instagram Hashtag Media Pipeline

Ingestion pipeline for Instagram hashtag media. Fetches `top_media` and
`recent_media` from the Meta Graph API, stores metadata in Postgres, copies media
files into object storage, deduplicates, and exposes a paginated read API.

Runs locally out of the box. Three environment variables switch it onto SQS, S3 and
EventBridge Scheduler with no code changes.

**Setup, environment variables, tradeoffs and AI usage: [instructions.md](instructions.md)**

---

## Architecture

```
                    ┌──────────────────────┐
                    │  Meta Graph API      │
                    │  top_media           │
                    │  recent_media        │
                    └──────────┬───────────┘
                               │ cursor pagination, 500-item cap,
                               │ adaptive page size, retry + backoff
                               ▼
  ┌──────────────┐    ┌─────────────────────┐    ┌──────────────────┐
  │  Scheduler   │───▶│  Queue              │───▶│  Worker          │
  │              │    │                     │    │                  │
  │ EventBridge  │    │ SQS + DLQ           │    │ JobRunner        │
  │   -- or --   │    │   -- or --          │    │ visibility       │
  │ node-cron    │    │ InMemoryQueue       │    │ heartbeat        │
  └──────────────┘    └─────────────────────┘    └────────┬─────────┘
   every 3 hours       at-least-once delivery              │
                                                           │
                        ┌──────────────────────────────────┴───┐
                        ▼                                      ▼
              ┌───────────────────┐                 ┌────────────────────┐
              │  Postgres         │                 │  Object storage    │
              │                   │                 │                    │
              │  raw payloads     │                 │  S3                │
              │  curated media    │                 │    -- or --        │
              │  metric snapshots │                 │  local disk        │
              │  assets           │                 │                    │
              │  caption entities │                 │  keyed by sha256   │
              │  sync run audit   │                 │                    │
              └─────────┬─────────┘                 └────────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  GET /hashtags    │
              │  keyset paginated │
              └───────────────────┘
```

### Job flow

```
EventBridge (or node-cron)
   └─▶ DISPATCH_DUE_SYNCS          ← names no hashtag; the worker resolves
                                     which are due from the database
        └─▶ SYNC_TOP_HASHTAG_MEDIA      one per active hashtag
        └─▶ SYNC_RECENT_HASHTAG_MEDIA
             └─▶ DOWNLOAD_MEDIA_ASSET   one per asset, so a single
                                        failed video cannot stall the rest
```

Adding a hashtag is a row insert — the schedule carries no hashtag name, so tracking
a new tag never requires touching AWS.

---

## Data model

Two layers, raw then curated.

| Table | Purpose |
| --- | --- |
| `hashtags` | what is tracked, with an optional tracking window |
| `sync_runs` | one row per ingestion attempt: pages, counts, duration, cursor, errors |
| `raw_media_payloads` | exactly what Meta returned, as JSONB. **Append-only** |
| `hashtag_media` | one row per unique post. `UNIQUE(ig_media_id)` |
| `media_metric_snapshots` | likes/comments/rank over time. **Append-only** |
| `media_assets` | the durable file copy, content-addressed by sha256 |
| `media_caption_entities` | hashtags and mentions parsed from captions |

**Why a raw layer.** Meta permits only 30 unique hashtags per rolling 7 days, and
`media_url` expires within days — so re-fetching is impossible, not merely expensive.
Without raw payloads, a parsing bug found on Friday loses Tuesday's data forever.
`pnpm replay <sync_run_id>` rebuilds the curated tables from them, spending zero API
quota.

**Why snapshots instead of overwriting.** `like_count` is an observation, not an
attribute. A post at 594 likes today and 1,200 next week is information — engagement
velocity, what is trending — and `UPDATE` destroys it permanently. Verified on live
data: one post moved 3 → 6 likes across runs.

**Why sha256 keys.** Two different posts can be byte-identical; reposts are common on
a tag like matcha. Content addressing stores the file once and makes repost clusters
queryable as rows sharing a hash. Same scheme git uses for its object store.

---

## Quick start

```bash
pnpm install
cp .env.example .env          # set META_ACCESS_TOKEN
docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm sync:top matcha
pnpm dev
```

Then `curl "http://localhost:3000/hashtags?limit=5"`, or browse the database at
http://localhost:8081.

---

## Notes from building against the real API

Three behaviours that are not in Meta's documentation and shaped the implementation:

- **The page-size limit is far below the documented 50, and moves.** `top_media`
  rejected `limit=10`; `recent_media` rejected `limit=25`. Not field-dependent —
  `fields=id` alone at `limit=25` fails. The client negotiates the size down until
  accepted, remembers it, and probes back up.
- **That error arrives as HTTP 500.** A client-side problem dressed as a server
  fault, so status-based retry classification blind-retries a doomed request. The
  Graph error code is checked first.
- **The edges take ~8s per page.** A 500-item sync is ~83 requests over ~11 minutes,
  which is why the work belongs in a queue and why runs are resumable from a cursor.

Full detail, including two bugs that only surfaced by running it, is in
[instructions.md](instructions.md#tradeoffs).

---

## Stack

TypeScript, Express, Postgres 16, Drizzle ORM, Zod, pino, Vitest, Docker Compose,
AWS SDK v3 (S3, SQS, EventBridge Scheduler, IAM, STS).

`pnpm test` — 43 tests. `pnpm typecheck` / `pnpm lint`.
