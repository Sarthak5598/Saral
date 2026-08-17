import { z } from 'zod';


export const listHashtagMediaQuerySchema = z.object({
  hashtag: z.string().min(1).max(255).optional(),

  limit: z.coerce.number().int().min(1).max(100).default(25),

  cursor: z.string().min(1).optional(),

  mediaType: z.enum(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']).optional(),

  
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
