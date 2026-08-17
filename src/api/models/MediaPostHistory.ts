import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { mediaSourceEnum, mediaTypeEnum } from './enums';
import { hashtags } from './Hashtag';
import { mediaPosts } from './MediaPost';
import { syncRuns } from './SyncRun';

/**
 * Append-only history of media_posts: a copy of a post's observable state, written
 * each time that state actually changes.
 *
 * The shape mirrors media_posts rather than holding metrics alone, which is what makes
 * the name honest - it is a history of the post, so a row can be read on its own to
 * see exactly what Meta reported at that moment, including the caption. A
 * metrics-only table would be narrower but could not answer "what did the caption say
 * in August".
 *
 * Two design points:
 *
 *  - **Change-only.** A row is written only when like_count, comments_count, rank,
 *    caption, permalink or media_type differs from the most recent history row. Most
 *    syncs re-observe identical values on older posts, so recording every observation
 *    would be overwhelmingly duplicates. The trade-off is that a gap no longer
 *    distinguishes "unchanged" from "not checked" - sync_runs resolves that, since it
 *    records every run and which hashtag it covered.
 *
 *  - **Append-only.** Inserts never rewrite existing rows, so this table grows without
 *    the MVCC bloat that repeated UPDATEs would cause. That is also why the current
 *    values are denormalised onto media_posts: reads hit one narrow row instead of
 *    scanning history.
 *
 * Cost, measured: a row is ~700 bytes with caption and tag arrays, versus ~60 for
 * metrics alone. At change-only write rates that is a few hundred MB a year - cheap
 * against being able to reconstruct any post's past.
 */
export const mediaPostHistory = pgTable(
  'media_post_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    mediaId: uuid('media_id')
      .notNull()
      .references(() => mediaPosts.id, { onDelete: 'cascade' }),

    /**
     * Denormalised so hashtag-scoped analytics need no join, and so this table can be
     * partitioned by hashtag if it grows large. Consistent with data_points, which
     * carries the same column for the same reason. Safe to duplicate: a post's hashtag
     * never changes after insert.
     */
    hashtagId: uuid('hashtag_id')
      .notNull()
      .references(() => hashtags.id, { onDelete: 'restrict' }),

    /** Which run observed this state. Provenance back to the audit trail. */
    syncRunId: uuid('sync_run_id')
      .notNull()
      .references(() => syncRuns.id, { onDelete: 'cascade' }),

    /** Copied so a history row is readable without joining back to the post. */
    igMediaId: text('ig_media_id').notNull(),

    // --- the post's observable state at capture time -------------------------

    mediaType: mediaTypeEnum('media_type').notNull(),
    caption: text('caption'),
    permalink: text('permalink').notNull(),
    captionHashtags: text('caption_hashtags').array(),
    captionMentions: text('caption_mentions').array(),

    likeCount: integer('like_count'),
    commentsCount: integer('comments_count'),

    /**
     * Position in the response that produced this row. For top_media this is a
     * popularity rank - tracking it across rows shows a post moving from #22 to #4,
     * which no single response can tell you. NULL for recent_media, where position is
     * chronological and carries no ranking meaning.
     *
     * Counts as a change in its own right: sliding from #4 to #9 is real movement even
     * when the like count is identical.
     */
    rank: integer('rank'),

    source: mediaSourceEnum('source').notNull(),

    /**
     * Which fields differed from the previous history row, so "why does this row
     * exist" is answerable without diffing against the preceding one.
     */
    changedFields: text('changed_fields').array(),

    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * At most one row per post per run. Change-only writes make this naturally true,
     * but the constraint keeps it true under concurrent redelivery of the same SQS
     * message rather than relying on the check winning the race.
     */
    mediaRunUnique: uniqueIndex('media_post_history_media_run_unique').on(
      table.mediaId,
      table.syncRunId,
    ),

    /** Drives "history for this post, newest first", and the change comparison. */
    mediaCapturedIdx: index('media_post_history_media_captured_idx').on(
      table.mediaId,
      table.capturedAt,
    ),
    hashtagCapturedIdx: index('media_post_history_hashtag_captured_idx').on(
      table.hashtagId,
      table.capturedAt,
    ),
  }),
);

export type MediaPostHistory = typeof mediaPostHistory.$inferSelect;
export type NewMediaPostHistory = typeof mediaPostHistory.$inferInsert;
