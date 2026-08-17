import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { mediaSourceEnum } from './enums';
import { hashtags } from './Hashtag';
import { syncRuns } from './SyncRun';

/**
 * The raw landing layer: exactly what Meta returned, unparsed, append-only.
 *
 * This table exists because of two hard constraints in the Meta API that make
 * re-fetching impossible rather than merely expensive:
 *
 *  1. Only 30 unique hashtags may be queried per rolling 7 days per IG account.
 *     There is no "just run it again" - the quota is the quota.
 *  2. `media_url` is a signed CDN link that expires within days. Even with quota
 *     to spare, the asset behind an old response is unrecoverable.
 *
 * So this is the ability to rebuild the curated tables from history without
 * spending a single API call - whether that is fixing a parsing bug, or
 * extracting a field nobody thought to parse the first time. `pnpm replay`
 * reads this table and nothing else.
 *
 * Rows are never UPDATEd and never deduplicated: the same media appearing on
 * three consecutive runs correctly produces three rows, because the point is to
 * record what the API said at a moment in time.
 */
export const rawMediaPayloads = pgTable(
  'raw_media_payloads',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    syncRunId: uuid('sync_run_id')
      .notNull()
      // Deleting a run's audit record should take its raw payloads with it -
      // they are meaningless without the run context.
      .references(() => syncRuns.id, { onDelete: 'cascade' }),

    hashtagId: uuid('hashtag_id')
      .notNull()
      .references(() => hashtags.id, { onDelete: 'restrict' }),

    /**
     * Instagram's media ID, lifted out of the payload into its own column purely
     * so the raw layer is queryable without JSONB extraction on every lookup.
     * Intentionally *not* unique here - that constraint belongs to the curated
     * layer.
     */
    igMediaId: text('ig_media_id').notNull(),

    source: mediaSourceEnum('source').notNull(),

    /**
     * Position within the response. For top_media this is a popularity ranking,
     * which is signal in its own right: comparing rank across runs shows a post
     * climbing or falling out of the top set.
     */
    pageNumber: integer('page_number').notNull(),
    positionInPage: integer('position_in_page').notNull(),
    positionOverall: integer('position_overall').notNull(),

    /** The unmodified media object from Meta's `data` array. */
    payload: jsonb('payload').notNull(),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    igMediaIdIdx: index('raw_media_payloads_ig_media_id_idx').on(table.igMediaId),
    syncRunIdx: index('raw_media_payloads_sync_run_idx').on(table.syncRunId),
    // Supports "replay everything for this hashtag in fetch order".
    hashtagFetchedIdx: index('raw_media_payloads_hashtag_fetched_idx').on(
      table.hashtagId,
      table.fetchedAt,
    ),
  }),
);

export type RawMediaPayload = typeof rawMediaPayloads.$inferSelect;
export type NewRawMediaPayload = typeof rawMediaPayloads.$inferInsert;
