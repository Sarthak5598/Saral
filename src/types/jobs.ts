import { z } from 'zod';

/**
 * Queue message contracts.
 *
 * These are validated with Zod on the consuming side rather than trusted, because
 * a queue message is untrusted input: it crosses a network boundary, it may have
 * been written by an older deploy, and under AWS it is authored by EventBridge
 * rather than by our own code.
 */

export const JobType = {
  /**
   * Fan-out dispatcher. This is the only job EventBridge Scheduler sends, and it
   * carries no hashtag - the schedule cannot know which tags are tracked.
   *
   * The worker resolves the due hashtags from the database and enqueues one sync
   * job each. That indirection is what makes adding a hashtag a row insert
   * instead of an EventBridge reconfiguration.
   */
  DISPATCH_DUE_SYNCS: 'DISPATCH_DUE_SYNCS',

  SYNC_TOP_HASHTAG_MEDIA: 'SYNC_TOP_HASHTAG_MEDIA',
  SYNC_RECENT_HASHTAG_MEDIA: 'SYNC_RECENT_HASHTAG_MEDIA',

  /**
   * One job per asset, deliberately not one job per sync. A single 404 video must
   * fail and retry on its own without touching the other 499 items, and asset
   * downloads are far slower than metadata writes so they need to scale
   * independently.
   */
  DOWNLOAD_MEDIA_ASSET: 'DOWNLOAD_MEDIA_ASSET',
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];

const dispatchDueSyncsJob = z.object({
  type: z.literal(JobType.DISPATCH_DUE_SYNCS),
  kind: z.enum(['top', 'recent']),
});

const syncTopJob = z.object({
  type: z.literal(JobType.SYNC_TOP_HASHTAG_MEDIA),
  hashtagId: z.string().uuid(),
});

const syncRecentJob = z.object({
  type: z.literal(JobType.SYNC_RECENT_HASHTAG_MEDIA),
  hashtagId: z.string().uuid(),
});

const downloadAssetJob = z.object({
  type: z.literal(JobType.DOWNLOAD_MEDIA_ASSET),
  mediaId: z.string().uuid(),
});

export const jobSchema = z.discriminatedUnion('type', [
  dispatchDueSyncsJob,
  syncTopJob,
  syncRecentJob,
  downloadAssetJob,
]);

export type Job = z.infer<typeof jobSchema>;
export type DispatchDueSyncsJob = z.infer<typeof dispatchDueSyncsJob>;
export type SyncTopJob = z.infer<typeof syncTopJob>;
export type SyncRecentJob = z.infer<typeof syncRecentJob>;
export type DownloadAssetJob = z.infer<typeof downloadAssetJob>;

/** Maps a sync job type onto the Meta edge and the sync_runs enum value. */
export function syncKindFor(type: JobType): 'top' | 'recent' | null {
  if (type === JobType.SYNC_TOP_HASHTAG_MEDIA) {
    return 'top';
  }
  if (type === JobType.SYNC_RECENT_HASHTAG_MEDIA) {
    return 'recent';
  }
  return null;
}
