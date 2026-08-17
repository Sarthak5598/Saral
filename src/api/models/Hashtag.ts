import { sql } from 'drizzle-orm';
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

/**
 * The set of hashtags being tracked. `matcha` is seeded as one row - nothing in
 * the codebase hardcodes it, so adding a tag is an INSERT rather than a deploy.
 *
 * The scheduler selects rows that are active and inside their tracking window,
 * then fans out one sync job per row.
 */
export const hashtags = pgTable(
  'hashtags',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Normalised: lowercase, no leading '#'. Unique so a tag is tracked once. */
    name: text('name').notNull(),

    /**
     * Meta's opaque hashtag ID, cached after the first ig_hashtag_search call.
     *
     * This cache is not an optimisation - it is a quota control. Meta allows only
     * 30 *unique* hashtags per rolling 7 days per IG account, so re-resolving on
     * every sync would burn the allowance and eventually hard-fail.
     */
    igHashtagId: text('ig_hashtag_id'),
    igHashtagIdResolvedAt: timestamp('ig_hashtag_id_resolved_at', { withTimezone: true }),

    isActive: boolean('is_active').notNull().default(true),

    /**
     * Tracking window. These gate *when the scheduler runs*, deliberately not
     * which media gets kept: discarding media we already spent API quota to fetch
     * would be wasteful and unrecoverable (see raw_media_payloads). Filtering by
     * post age is a read-time concern, handled by the API's `takenAfter` filter.
     *
     * NULL means unbounded in that direction.
     */
    trackFrom: timestamp('track_from', { withTimezone: true }),
    trackUntil: timestamp('track_until', { withTimezone: true }),

    /**
     * top_media is a snapshot of all-time popular posts, so it rarely needs
     * re-fetching; recent_media is the one on the 3-hour cadence. Being able to
     * disable either per hashtag keeps quota under control.
     */
    topSyncEnabled: boolean('top_sync_enabled').notNull().default(true),
    recentSyncEnabled: boolean('recent_sync_enabled').notNull().default(true),

    /** Per-hashtag override of SYNC_MAX_MEDIA_PER_RUN. NULL = use the global. */
    maxMediaPerSync: integer('max_media_per_sync'),

    lastTopSyncedAt: timestamp('last_top_synced_at', { withTimezone: true }),
    lastRecentSyncedAt: timestamp('last_recent_synced_at', { withTimezone: true }),

    /**
     * Failure tracking so a permanently broken hashtag (deleted tag, revoked
     * token) is visible in a query instead of only in scrollback.
     */
    lastSyncError: text('last_sync_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameUnique: uniqueIndex('hashtags_name_unique').on(table.name),
    // Partial unique: many rows may have a NULL ig_hashtag_id before first
    // resolution, but a resolved ID must map to exactly one row.
    igHashtagIdUnique: uniqueIndex('hashtags_ig_hashtag_id_unique')
      .on(table.igHashtagId)
      .where(sql`${table.igHashtagId} IS NOT NULL`),
    // Drives the scheduler's "which hashtags are due?" query.
    activeIdx: index('hashtags_active_idx').on(table.isActive),
  }),
);

export type Hashtag = typeof hashtags.$inferSelect;
export type NewHashtag = typeof hashtags.$inferInsert;
