import { z } from 'zod';

/**
 * Zod schemas for Meta Graph API responses.
 *
 * Validated rather than cast, for two reasons: the response is third-party input
 * that can change without notice, and a malformed payload should fail at the
 * boundary with a readable error rather than surfacing as a null constraint
 * violation three layers down.
 *
 * The field list is exactly what Meta exposes for hashtag media - verified live
 * against v24.0. Hashtag search returns no username, no owner ID, no follower
 * data and no location, because Meta strips owner and place information for
 * media on accounts you do not own. `children` (carousel sub-images) is also
 * rejected for this edge, so a CAROUSEL_ALBUM yields one cover image.
 */

export const metaMediaTypeSchema = z.enum(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']);

export const metaMediaSchema = z.object({
  id: z.string().min(1),
  media_type: metaMediaTypeSchema,
  /** Meta's format is `2026-08-12T17:08:55+0000` - note no colon in the offset. */
  timestamp: z.string().min(1),
  permalink: z.string().url(),
  /**
   * Optional in practice. Some media comes back without a usable URL, which is
   * not an error - it becomes an asset with status 'skipped'.
   */
  media_url: z.string().url().optional(),
  caption: z.string().optional(),
  like_count: z.number().int().nonnegative().optional(),
  comments_count: z.number().int().nonnegative().optional(),
});

export type MetaMedia = z.infer<typeof metaMediaSchema>;

export const metaPagingSchema = z
  .object({
    cursors: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
    next: z.string().url().optional(),
    previous: z.string().url().optional(),
  })
  .optional();

export const metaMediaResponseSchema = z.object({
  data: z.array(metaMediaSchema),
  paging: metaPagingSchema,
});

export type MetaMediaResponse = z.infer<typeof metaMediaResponseSchema>;

export const metaHashtagSearchResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

/** Meta's error envelope. Present on non-2xx, and occasionally on a 200. */
export const metaErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
  }),
});

/**
 * The fields requested from the media edges. Kept as a single constant so the
 * request, the Zod schema and the database columns cannot drift apart.
 */
export const MEDIA_FIELDS = [
  'id',
  'media_type',
  'timestamp',
  'permalink',
  'media_url',
  'caption',
  'like_count',
  'comments_count',
] as const;

/**
 * Meta returns `+0000` where ISO 8601 wants `+00:00`. V8 happens to accept the
 * former, but relying on that is a latent bug, so normalise explicitly and reject
 * anything unparseable instead of silently storing an Invalid Date.
 */
export function parseMetaTimestamp(raw: string): Date {
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = new Date(normalized);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`unparseable Meta timestamp: ${raw}`);
  }

  return parsed;
}
