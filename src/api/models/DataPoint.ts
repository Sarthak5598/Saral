import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { mediaSourceEnum } from './enums';
import { hashtags } from './Hashtag';
import { syncRuns } from './SyncRun';

/**
 * The raw landing layer: exactly what Meta returned, unparsed, append-only.
 *
 * One row per media object per response - a single observed data point, before any of
 * our own interpretation is applied.
 *
 * This exists because of two hard constraints that make re-fetching impossible rather
 * than merely expensive:
 *
 *  1. Only 30 unique hashtags may be queried per rolling 7 days per Instagram
 *     account. There is no "just run it again" - the quota is the quota.
 *  2. media_url is a signed CDN link that expires within days. Even with quota to
 *     spare, the file behind an old response is unrecoverable.
 *
 * So this table is the ability to rebuild the curated tables from history without
 * spending a single API call - whether that means fixing a parsing bug or extracting a
 * field nobody thought to parse the first time. `pnpm replay` reads this and nothing
 * else.
 *
 * Rows are never UPDATEd and never deduplicated: the same media appearing on three
 * consecutive runs correctly produces three rows, because the point is to record what
 * the API said at a moment in time.
 */
export const dataPoints = pgTable(
  'data_points',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    syncRunId: uuid('sync_run_id')
      .notNull()
      // Deleting a run's audit record should take its data points with it - they are
      // meaningless without the run context.
      .references(() => syncRuns.id, { onDelete: 'cascade' }),

    hashtagId: uuid('hashtag_id')
      .notNull()
      .references(() => hashtags.id, { onDelete: 'restrict' }),

    /**
     * Instagram's media ID, lifted out of the payload into its own column so the raw
     * layer is queryable without JSONB extraction on every lookup. Intentionally *not*
     * unique here - that constraint belongs to the curated layer.
     */
    igMediaId: text('ig_media_id').notNull(),

    source: mediaSourceEnum('source').notNull(),

    /**
     * Position within the response. For top_media this is a popularity ranking, which
     * is signal in its own right: comparing rank across runs shows a post climbing or
     * falling out of the top set.
     */
    pageNumber: integer('page_number').notNull(),
    positionInPage: integer('position_in_page').notNull(),
    positionOverall: integer('position_overall').notNull(),

    /** The unmodified media object from Meta's `data` array. */
    payload: jsonb('payload').notNull(),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    igMediaIdIdx: index('data_points_ig_media_id_idx').on(table.igMediaId),
    syncRunIdx: index('data_points_sync_run_idx').on(table.syncRunId),
    // Supports "replay everything for this hashtag, in fetch order".
    hashtagFetchedIdx: index('data_points_hashtag_fetched_idx').on(
      table.hashtagId,
      table.fetchedAt,
    ),
  }),
);

export type DataPoint = typeof dataPoints.$inferSelect;
export type NewDataPoint = typeof dataPoints.$inferInsert;
