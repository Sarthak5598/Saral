import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { mediaSourceEnum, mediaTypeEnum } from './enums';
import { hashtags } from './Hashtag';

/**
 * The curated layer: one row per unique Instagram post.
 *
 * Deduplication is enforced by the database, not by application logic. The
 * ingestion path uses INSERT ... ON CONFLICT (ig_media_id) DO UPDATE, which is
 * correct under concurrency; a "SELECT then INSERT if absent" check is not -
 * two workers can both see nothing and both insert.
 *
 * That matters here specifically because SQS Standard delivers at-least-once, so
 * processing the same message twice is expected behaviour, not an edge case.
 */
export const hashtagMedia = pgTable(
  'hashtag_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The deduplication key. Everything else in this file follows from it. */
    igMediaId: text('ig_media_id').notNull(),

    hashtagId: uuid('hashtag_id')
      .notNull()
      .references(() => hashtags.id, { onDelete: 'restrict' }),

    // -----------------------------------------------------------------------
    // Fields Meta actually provides for hashtag media.
    //
    // The complete available set is: id, caption, media_type, media_url,
    // permalink, timestamp, like_count, comments_count. Hashtag search returns
    // no username, no owner ID, no follower count and no location - Meta strips
    // owner and place data for media on accounts you do not own. `children`
    // (carousel sub-images) is rejected by the API for this edge, verified
    // against v24.0, so a CAROUSEL_ALBUM yields exactly one cover image.
    // -----------------------------------------------------------------------

    mediaType: mediaTypeEnum('media_type').notNull(),

    caption: text('caption'),
    permalink: text('permalink').notNull(),

    /**
     * The signed CDN URL from Meta. Stored deliberately as a *transient* fetch
     * source, never as the URL to serve to clients - it expires within days.
     * The durable copy lives in media_assets. `permalink` is the stable public
     * link; this is not.
     */
    sourceMediaUrl: text('source_media_url'),

    // -----------------------------------------------------------------------
    // Timestamps. Four columns because they answer four different questions, and
    // collapsing them into one `updated_at` destroys the distinction that makes
    // change tracking possible.
    // -----------------------------------------------------------------------

    /** Meta's `timestamp` - when the post was published. Immutable. */
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),

    /** First time this pipeline ever saw the post. Never changes after insert. */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),

    /** Bumped on every sync that returns the post, whether or not it changed. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Bumped only when durable content actually changed - caption edited, type
     * or permalink differs. Metric changes do NOT touch this; they land in
     * media_metric_snapshots. Setting this on every sync would make every row
     * look freshly edited when nothing had happened.
     */
    contentUpdatedAt: timestamp('content_updated_at', { withTimezone: true }),

    // -----------------------------------------------------------------------
    // Current metric values, denormalised from the latest snapshot so the read
    // API does not need a correlated subquery per row. The authoritative
    // history is media_metric_snapshots.
    // -----------------------------------------------------------------------

    likeCount: integer('like_count'),
    commentsCount: integer('comments_count'),
    metricsUpdatedAt: timestamp('metrics_updated_at', { withTimezone: true }),

    /** Which edge first surfaced this post, and whether it has ever been in top. */
    firstSeenVia: mediaSourceEnum('first_seen_via').notNull(),
    seenInTop: boolean('seen_in_top').notNull().default(false),
    seenInRecent: boolean('seen_in_recent').notNull().default(false),

    /** Best (numerically lowest) rank ever observed in a top_media response. */
    bestTopRank: integer('best_top_rank'),

    /**
     * Set when the post stops appearing in responses for long enough that it was
     * likely deleted or made private. Soft flag, never a DELETE: the metric
     * history and downloaded asset stay valid and worth keeping.
     */
    isStale: boolean('is_stale').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** The constraint that makes duplicates impossible rather than unlikely. */
    igMediaIdUnique: uniqueIndex('hashtag_media_ig_media_id_unique').on(table.igMediaId),

    /**
     * The read API's primary index. Composite on (hashtag, taken_at DESC, id
     * DESC) because pagination is keyset-based: offset pagination shifts rows
     * when new media arrives mid-scroll, and `id` breaks ties so the ordering is
     * total and the cursor is stable.
     */
    hashtagTakenAtIdx: index('hashtag_media_hashtag_taken_at_idx').on(
      table.hashtagId,
      table.takenAt,
      table.id,
    ),

    /** Supports stale detection sweeps. */
    lastSeenIdx: index('hashtag_media_last_seen_idx').on(table.lastSeenAt),
    mediaTypeIdx: index('hashtag_media_media_type_idx').on(table.mediaType),
  }),
);

export type HashtagMedia = typeof hashtagMedia.$inferSelect;
export type NewHashtagMedia = typeof hashtagMedia.$inferInsert;
