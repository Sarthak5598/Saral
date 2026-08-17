import { index, integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { mediaSourceEnum } from './enums';
import { hashtagMedia } from './HashtagMedia';
import { syncRuns } from './SyncRun';

/**
 * Append-only time series of engagement metrics.
 *
 * The design decision worth defending: like_count and comments_count are
 * *observations*, not attributes. A post at 594 likes today and 1,200 next week
 * is information - engagement velocity, what is trending, which post is
 * climbing. UPDATEing a single column destroys that information permanently,
 * and it is information this pipeline is already paying for, eight times a day.
 *
 * So metrics are appended here and the current values are denormalised onto
 * hashtag_media for cheap reads.
 *
 * Growth is bounded and small: 500 posts x 8 runs/day is ~4k rows/day, ~1.5M/year.
 * Trivial for Postgres, and a natural candidate for monthly range partitioning
 * if it ever stopped being trivial.
 */
export const mediaMetricSnapshots = pgTable(
  'media_metric_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    mediaId: uuid('media_id')
      .notNull()
      .references(() => hashtagMedia.id, { onDelete: 'cascade' }),

    syncRunId: uuid('sync_run_id')
      .notNull()
      .references(() => syncRuns.id, { onDelete: 'cascade' }),

    likeCount: integer('like_count'),
    commentsCount: integer('comments_count'),

    /**
     * Position in the response that produced this snapshot. For top_media this is
     * a popularity rank - tracking it across runs shows a post moving from #22 to
     * #4, which no single response can tell you. NULL for recent_media, where
     * position is chronological and carries no ranking meaning.
     */
    rank: integer('rank'),

    source: mediaSourceEnum('source').notNull(),

    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * One snapshot per media per run. This is what makes the consumer idempotent
     * under at-least-once SQS delivery: a redelivered message re-inserts and
     * conflicts instead of doubling the time series.
     */
    mediaRunUnique: uniqueIndex('media_metric_snapshots_media_run_unique').on(
      table.mediaId,
      table.syncRunId,
    ),

    /** Drives "metric history for this post, newest first". */
    mediaCapturedIdx: index('media_metric_snapshots_media_captured_idx').on(
      table.mediaId,
      table.capturedAt,
    ),
    capturedAtIdx: index('media_metric_snapshots_captured_at_idx').on(table.capturedAt),
  }),
);

export type MediaMetricSnapshot = typeof mediaMetricSnapshots.$inferSelect;
export type NewMediaMetricSnapshot = typeof mediaMetricSnapshots.$inferInsert;
