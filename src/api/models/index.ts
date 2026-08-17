/**
 * Schema barrel. drizzle.config.ts points at this file, so every table must be
 * re-exported here or drizzle-kit will not see it when diffing migrations.
 *
 * Layering, raw -> curated:
 *
 *   hashtags                  what we track, and when
 *   sync_runs                 one row per ingestion attempt (audit)
 *   raw_media_payloads        exactly what Meta returned  [append-only]
 *   hashtag_media             one row per unique post      [deduplicated]
 *   media_metric_snapshots    engagement over time         [append-only]
 *   media_assets              the durable copy of the file
 *   media_caption_entities    hashtags/mentions parsed from captions [derived]
 */

export * from './enums';
export * from './Hashtag';
export * from './SyncRun';
export * from './RawMediaPayload';
export * from './HashtagMedia';
export * from './MediaMetricSnapshot';
export * from './MediaAsset';
export * from './MediaCaptionEntity';
