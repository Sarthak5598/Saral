/**
 * Schema barrel. drizzle.config.ts points at this file, so every table must be
 * re-exported here or drizzle-kit will not see it when diffing migrations.
 *
 * Layering, raw -> curated:
 *
 *   hashtags             what we track, and when
 *   sync_runs            one row per ingestion attempt (audit)
 *   data_points          exactly what Meta returned        [append-only]
 *   media_posts          one row per unique post           [deduplicated]
 *   media_post_history   the post's state each time it changed  [append-only]
 *   media_assets         the durable copy of the file
 *
 * Caption hashtags and mentions live as arrays on media_posts rather than in their own
 * table: Instagram caps captions at 30 hashtags, so the list is bounded, and the
 * caption belongs to the post rather than to a measurement.
 */

export * from './enums';
export * from './Hashtag';
export * from './SyncRun';
export * from './DataPoint';
export * from './MediaPost';
export * from './MediaPostHistory';
export * from './MediaAsset';
