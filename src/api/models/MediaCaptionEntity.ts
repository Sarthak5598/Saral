import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { captionEntityTypeEnum } from './enums';
import { hashtagMedia } from './HashtagMedia';

/**
 * Hashtags and @mentions parsed out of the caption text.
 *
 * Meta gives no owner, no follower data and no location for hashtag media, so
 * the caption is the only enrichment surface available. Parsing it is what turns
 * a flat archive into something answerable:
 *
 *  - "what else do people tag alongside #matcha?" -> co-occurrence over `hashtag`
 *  - "which brands get tagged in matcha posts?"   -> aggregate over `mention`
 *
 * These values are *derived*, not authoritative. A caption reading "#kyoto" is a
 * soft geographic hint, not a location field - worth treating as a signal and
 * never as a fact.
 */
export const mediaCaptionEntities = pgTable(
  'media_caption_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    mediaId: uuid('media_id')
      .notNull()
      .references(() => hashtagMedia.id, { onDelete: 'cascade' }),

    type: captionEntityTypeEnum('type').notNull(),

    /**
     * Normalised: lowercased, leading '#' or '@' stripped. Length-capped because
     * Instagram enforces its own limits and an unbounded text column here invites
     * junk from malformed captions.
     */
    value: varchar('value', { length: 255 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * A caption may repeat the same tag; we store the distinct set. Also makes
     * re-parsing (during replay) naturally idempotent.
     */
    mediaTypeValueUnique: uniqueIndex('media_caption_entities_media_type_value_unique').on(
      table.mediaId,
      table.type,
      table.value,
    ),

    /** Drives co-occurrence aggregation: GROUP BY value WHERE type = 'hashtag'. */
    typeValueIdx: index('media_caption_entities_type_value_idx').on(table.type, table.value),
  }),
);

export type MediaCaptionEntity = typeof mediaCaptionEntities.$inferSelect;
export type NewMediaCaptionEntity = typeof mediaCaptionEntities.$inferInsert;
