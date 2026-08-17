import { z } from 'zod';

/**
 * Query validation for GET /hashtags.
 *
 * Coerced and bounded rather than trusted: `limit` has a hard ceiling so a client
 * cannot ask for the whole table in one request, and an unparseable cursor is a
 * 400 rather than a 500 from a malformed SQL comparison.
 */
export const listHashtagMediaQuerySchema = z.object({
  /** Hashtag name, without '#'. Omitted means every tracked hashtag. */
  hashtag: z.string().min(1).max(255).optional(),

  limit: z.coerce.number().int().min(1).max(100).default(25),

  /** Opaque keyset cursor from a previous response's `nextCursor`. */
  cursor: z.string().min(1).optional(),

  mediaType: z.enum(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']).optional(),

  /**
   * Filters on the post's own timestamp, which is what the hashtags table's
   * tracking window deliberately does not do - that window gates when we sync, so
   * restricting by post age belongs here at read time.
   */
  takenAfter: z.coerce.date().optional(),
  takenBefore: z.coerce.date().optional(),

  /** Exclude posts that have stopped appearing in Meta's responses. */
  includeStale: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /** Include the stored-asset details for each item. */
  includeAsset: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type ListHashtagMediaQuery = z.infer<typeof listHashtagMediaQuerySchema>;
