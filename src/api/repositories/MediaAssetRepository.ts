import { eq, inArray, sql } from 'drizzle-orm';

import { db } from '../../database/client';
import type { MediaAsset } from '../models';
import { mediaAssets } from '../models';

/**
 * Creates the pending asset row for a media item, if absent.
 *
 * Idempotent via UNIQUE(media_id): a redelivered sync will not create a second
 * download job's worth of state. Returns whether a row was created, so the caller
 * only enqueues a download job for genuinely new work.
 */
export async function ensurePending(
  mediaId: string,
  sourceUrl: string | null,
): Promise<{ id: string; created: boolean }> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      mediaId,
      // No media_url is not a failure - Meta does return media without one. It is
      // recorded as skipped so it never enters the retry path.
      status: sourceUrl ? 'pending' : 'skipped',
      fetchedFromUrl: sourceUrl,
    })
    .onConflictDoUpdate({
      target: mediaAssets.mediaId,
      set: {
        // Refresh the URL: the stored one has probably expired, and the new sync
        // just handed us a live signed link.
        fetchedFromUrl: sourceUrl,
        updatedAt: new Date(),
      },
    })
    .returning({ id: mediaAssets.id, createdAt: mediaAssets.createdAt, status: mediaAssets.status });

  if (!row) {
    throw new Error(`failed to upsert asset row for media ${mediaId}`);
  }

  // Only 'pending' rows need a download job. 'stored' means the bytes are already
  // safe; re-downloading them would waste bandwidth for no gain.
  return { id: row.id, created: row.status === 'pending' };
}

export async function findByMediaId(mediaId: string): Promise<MediaAsset | undefined> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.mediaId, mediaId))
    .limit(1);

  return rows[0];
}

export async function markDownloading(mediaId: string): Promise<void> {
  await db
    .update(mediaAssets)
    .set({
      status: 'downloading',
      downloadStartedAt: new Date(),
      // Incremented in SQL so two workers cannot both read 1 and both write 2.
      attempts: sql`${mediaAssets.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(mediaAssets.mediaId, mediaId));
}

export async function markStored(
  mediaId: string,
  stored: {
    sha256: string;
    storageKey: string;
    storageProvider: string;
    contentType?: string | undefined;
    sizeBytes: number;
  },
): Promise<void> {
  await db
    .update(mediaAssets)
    .set({
      status: 'stored',
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      storageProvider: stored.storageProvider,
      contentType: stored.contentType ?? null,
      sizeBytes: stored.sizeBytes,
      storedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mediaAssets.mediaId, mediaId));
}

export async function markFailed(mediaId: string, error: string): Promise<void> {
  await db
    .update(mediaAssets)
    .set({ status: 'failed', lastError: error.slice(0, 2000), updatedAt: new Date() })
    .where(eq(mediaAssets.mediaId, mediaId));
}

export async function markSkipped(mediaId: string, reason: string): Promise<void> {
  await db
    .update(mediaAssets)
    .set({ status: 'skipped', lastError: reason.slice(0, 2000), updatedAt: new Date() })
    .where(eq(mediaAssets.mediaId, mediaId));
}

/**
 * Assets still awaiting download. Backs a retry sweep for work orphaned by a
 * worker that died between enqueueing and storing.
 */
export async function findRetryable(limit = 100): Promise<MediaAsset[]> {
  return db
    .select()
    .from(mediaAssets)
    .where(inArray(mediaAssets.status, ['pending', 'failed', 'downloading']))
    .limit(limit);
}

/**
 * Media rows sharing a sha256 - byte-identical files stored under different
 * Instagram media IDs.
 *
 * This is repost detection, and it comes free from content-addressed storage
 * rather than needing image comparison.
 */
export async function findRepostClusters(
  minCount = 2,
): Promise<Array<{ sha256: string; mediaCount: number }>> {
  const rows = await db
    .select({
      sha256: mediaAssets.sha256,
      mediaCount: sql<number>`count(*)::int`,
    })
    .from(mediaAssets)
    .where(sql`${mediaAssets.sha256} IS NOT NULL`)
    .groupBy(mediaAssets.sha256)
    .having(sql`count(*) >= ${minCount}`);

  return rows.map((row) => ({ sha256: row.sha256 ?? '', mediaCount: row.mediaCount }));
}
