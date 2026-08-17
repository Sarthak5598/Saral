import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { syncRunStatusEnum, syncRunTypeEnum } from './enums';
import { hashtags } from './Hashtag';

/**
 * One row per ingestion attempt - the audit trail.
 *
 * This is what makes the pipeline answerable after the fact: how many pages were
 * walked, how many items were new versus already known, how long it took, and why it
 * stopped. It also gives every other table a foreign key to "the run that produced
 * this", which is what makes replay and debugging tractable.
 */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    type: syncRunTypeEnum('type').notNull(),
    status: syncRunStatusEnum('status').notNull().default('running'),

    hashtagId: uuid('hashtag_id')
      .notNull()
      // A hashtag can be untracked, but deleting it must not erase the history of
      // what was collected. Untracking sets is_active = false; it never DELETEs.
      .references(() => hashtags.id, { onDelete: 'restrict' }),

    /**
     * The SQS message ID (or local queue job ID) that triggered this run.
     *
     * Recorded because SQS Standard is at-least-once: if the same message is
     * delivered twice, two runs reference the same messageId, which makes duplicate
     * delivery visible rather than invisible.
     */
    triggeredByMessageId: text('triggered_by_message_id'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    pagesFetched: integer('pages_fetched').notNull().default(0),
    /** Items Meta returned, including ones already stored. */
    itemsSeen: integer('items_seen').notNull().default(0),
    /** Items that did not previously exist in media_posts. */
    itemsNew: integer('items_new').notNull().default(0),
    /** Existing items whose caption, type or permalink actually changed. */
    itemsUpdated: integer('items_updated').notNull().default(0),
    /**
     * Metric rows written. Lower than itemsSeen by design - metrics are recorded
     * only when a value actually changed.
     */
    metricsRecorded: integer('metrics_recorded').notNull().default(0),
    assetJobsEnqueued: integer('asset_jobs_enqueued').notNull().default(0),

    /**
     * Whether the run stopped because it hit SYNC_MAX_MEDIA_PER_RUN rather than
     * running out of pages. Without this, a truncated run is indistinguishable from
     * a complete one, which would silently misrepresent coverage.
     */
    hitItemCap: integer('hit_item_cap').notNull().default(0),

    /**
     * Meta's rate-limit headers from the final request of this run
     * (X-App-Usage / X-Business-Use-Case-Usage), as percentages of the allowance.
     * Kept so throttling can be correlated with slow or failed runs.
     */
    rateLimitSnapshot: jsonb('rate_limit_snapshot'),

    /**
     * Cursor of the last page fully persisted, making a failed run resumable rather
     * than restartable.
     *
     * Measured Meta behaviour makes this matter: the hashtag edges take ~8s per page
     * and accept only a handful of items each, so a 500-item sync is dozens of
     * requests over several minutes. Without this, a failure on page 70 discards 70
     * requests of quota that cannot be reclaimed.
     */
    lastCursor: text('last_cursor'),

    /**
     * How many times this run has been picked up. Under at-least-once delivery a
     * message can legitimately be redelivered; this makes a run that keeps failing
     * visible rather than invisible.
     */
    attempts: integer('attempts').notNull().default(1),

    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hashtagStartedIdx: index('sync_runs_hashtag_started_idx').on(table.hashtagId, table.startedAt),
    statusIdx: index('sync_runs_status_idx').on(table.status),
    typeStartedIdx: index('sync_runs_type_started_idx').on(table.type, table.startedAt),
  }),
);

export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
