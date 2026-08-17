import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enums rather than free-text columns: the set of values is small,
 * closed, and defined by Meta's API - so the database should reject anything
 * outside it instead of quietly storing a typo.
 */

/** Meta returns exactly these three for hashtag media. */
export const mediaTypeEnum = pgEnum('media_type', ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']);

/**
 * Which Meta edge surfaced a piece of media. A post can legitimately appear via
 * both, which is one of the two duplicate sources this pipeline has to absorb
 * (the other being the same post reappearing on every 3-hour run).
 */
export const mediaSourceEnum = pgEnum('media_source', ['top', 'recent']);

export const syncRunTypeEnum = pgEnum('sync_run_type', [
  'SYNC_TOP_HASHTAG_MEDIA',
  'SYNC_RECENT_HASHTAG_MEDIA',
]);

/**
 * `partial` is a real outcome, not a fudge: pagination can succeed for 8 pages
 * and fail on the 9th. Recording that as either "succeeded" or "failed" would
 * lose information a reviewer of the data needs.
 */
export const syncRunStatusEnum = pgEnum('sync_run_status', [
  'running',
  'succeeded',
  'partial',
  'failed',
]);

/**
 * Asset lifecycle. `skipped` covers media Meta returned without a usable
 * media_url, which happens and is not an error.
 */
export const assetStatusEnum = pgEnum('asset_status', [
  'pending',
  'downloading',
  'stored',
  'failed',
  'skipped',
]);

/** Entities parsed out of the caption text - the only enrichment Meta allows. */
export const captionEntityTypeEnum = pgEnum('caption_entity_type', ['hashtag', 'mention']);
