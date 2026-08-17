import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { assetStatusEnum } from './enums';
import { hashtagMedia } from './HashtagMedia';

/**
 * The durable copy of each media file, and the record of getting it there.
 *
 * This table is the answer to the expiring-URL problem: Meta's `media_url` is a
 * signed CDN link valid for days, so storing only the URL produces an app that
 * works today and shows broken images next week. The bytes have to be copied.
 *
 * Separate from hashtag_media rather than folded into it because download is an
 * independent, retryable, failure-prone operation with its own lifecycle. One
 * 404 video must not invalidate the metadata for 499 healthy posts.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    mediaId: uuid('media_id')
      .notNull()
      .references(() => hashtagMedia.id, { onDelete: 'cascade' }),

    status: assetStatusEnum('status').notNull().default('pending'),

    /**
     * SHA-256 of the downloaded bytes, used as the storage key.
     *
     * Content-addressing rather than keying by media ID, because two different
     * Instagram posts can be byte-identical - reposts are common on a tag like
     * #matcha. Hashing means the file is stored once no matter how many posts
     * carry it, and it makes reposts detectable: several media rows sharing one
     * sha256 is a repost cluster.
     *
     * NULL until the download completes, since the hash is only knowable then.
     */
    sha256: text('sha256'),

    /**
     * Provider-agnostic object key, e.g. `media/ab/cd/abcdef...jpg`. The two-level
     * prefix from the hash keeps directory fan-out sane on the local driver and
     * spreads S3 key space.
     */
    storageKey: text('storage_key'),
    /** Which driver wrote it - 'local' or 's3'. Recorded so a mixed-provider */
    /** dataset stays unambiguous after a migration from disk to S3. */
    storageProvider: text('storage_provider'),

    contentType: text('content_type'),
    /** bigint: video assets exceed the 2GB int4 ceiling far less often than */
    /** the cost of getting this wrong once. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),

    /**
     * The URL the bytes were actually fetched from, kept for forensics only.
     * It will be expired by the time anyone reads it.
     */
    fetchedFromUrl: text('fetched_from_url'),

    /** Retry bookkeeping. Surfaces poison assets without reading logs. */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),

    downloadStartedAt: timestamp('download_started_at', { withTimezone: true }),
    storedAt: timestamp('stored_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * One asset row per media. Given the `children` edge is unavailable for
     * hashtag search, a post - carousel included - yields exactly one file, so
     * this is a safe constraint and it makes the download job idempotent.
     */
    mediaUnique: uniqueIndex('media_assets_media_unique').on(table.mediaId),

    /** Finds the repost clusters, and lets an upload skip bytes already stored. */
    sha256Idx: index('media_assets_sha256_idx').on(table.sha256),
    /** Drives the retry sweep for pending/failed downloads. */
    statusIdx: index('media_assets_status_idx').on(table.status),
  }),
);

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
