import { and, eq, lt, sql } from 'drizzle-orm';

import { db } from '../../database/client';
import { parseMetaTimestamp, type MetaMedia } from '../../lib/meta/types';
import { parseCaptionEntities } from '../services/captionParser';
import type { HashtagMedia } from '../models';
import { hashtagMedia, mediaCaptionEntities, mediaMetricSnapshots } from '../models';

export interface UpsertMediaInput {
  media: MetaMedia;
  hashtagId: string;
  syncRunId: string;
  source: 'top' | 'recent';
  /** Position in the response. Meaningful as a popularity rank only for top. */
  rank: number;
}

export interface UpsertMediaResult {
  id: string;
  /** True only when this run created the row. Drives sync_runs.items_new. */
  isNew: boolean;
  /** True when durable content changed - caption edit, type or permalink change. */
  contentChanged: boolean;
}

/**
 * Inserts or refreshes one media row, appends a metric snapshot, and syncs the
 * parsed caption entities.
 *
 * The whole thing runs in one transaction: a media row without its snapshot, or
 * with half its caption entities, is a worse outcome than the page failing and
 * being retried.
 */
export async function upsertMedia(input: UpsertMediaInput): Promise<UpsertMediaResult> {
  const { media, hashtagId, syncRunId, source, rank } = input;
  const takenAt = parseMetaTimestamp(media.timestamp);
  const now = new Date();

  return db.transaction(async (tx) => {
    /**
     * Deduplication happens here, in the database.
     *
     * ON CONFLICT is not a convenience over "SELECT then INSERT if missing" - it
     * is the only correct option. Two workers running the check-then-insert
     * version can both see no row and both insert. That matters because SQS
     * delivers at-least-once, so concurrent processing of the same media is
     * expected rather than exceptional.
     */
    const [row] = await tx
      .insert(hashtagMedia)
      .values({
        igMediaId: media.id,
        hashtagId,
        mediaType: media.media_type,
        caption: media.caption ?? null,
        permalink: media.permalink,
        sourceMediaUrl: media.media_url ?? null,
        takenAt,
        firstSeenAt: now,
        lastSeenAt: now,
        likeCount: media.like_count ?? null,
        commentsCount: media.comments_count ?? null,
        metricsUpdatedAt: now,
        firstSeenVia: source,
        seenInTop: source === 'top',
        seenInRecent: source === 'recent',
        bestTopRank: source === 'top' ? rank : null,
      })
      .onConflictDoUpdate({
        target: hashtagMedia.igMediaId,
        set: {
          // Refreshed every time - these are current observations.
          caption: media.caption ?? null,
          sourceMediaUrl: media.media_url ?? null,
          likeCount: media.like_count ?? null,
          commentsCount: media.comments_count ?? null,
          metricsUpdatedAt: now,
          lastSeenAt: now,
          updatedAt: now,

          // Sticky flags: once seen in an edge, always seen in it. OR-ing rather
          // than assigning preserves the history that this post has appeared in
          // both top and recent.
          seenInTop: sql`${hashtagMedia.seenInTop} OR ${source === 'top'}`,
          seenInRecent: sql`${hashtagMedia.seenInRecent} OR ${source === 'recent'}`,

          // Best rank means numerically lowest. LEAST ignores NULLs, so a first
          // top-media sighting sets it correctly.
          bestTopRank:
            source === 'top'
              ? sql`LEAST(${hashtagMedia.bestTopRank}, ${rank})`
              : sql`${hashtagMedia.bestTopRank}`,

          // Reappearing clears the stale flag.
          isStale: sql`false`,

          /**
           * Only bumped when durable content actually differs. Setting this
           * unconditionally would mark every row as freshly edited on every sync,
           * which destroys the ability to find genuinely edited captions.
           * Metric changes deliberately do not count - they belong to the
           * snapshot table.
           */
          contentUpdatedAt: sql`
            CASE WHEN ${hashtagMedia.caption} IS DISTINCT FROM ${media.caption ?? null}
                   OR ${hashtagMedia.permalink} IS DISTINCT FROM ${media.permalink}
                   OR ${hashtagMedia.mediaType} IS DISTINCT FROM ${media.media_type}::media_type
                 THEN ${now}
                 ELSE ${hashtagMedia.contentUpdatedAt}
            END
          `,
        },
      })
      .returning({
        id: hashtagMedia.id,
        firstSeenAt: hashtagMedia.firstSeenAt,
        contentUpdatedAt: hashtagMedia.contentUpdatedAt,
      });

    if (!row) {
      throw new Error(`upsert returned no row for media ${media.id}`);
    }

    // firstSeenAt is only ever written on insert, so equality with this run's
    // timestamp is a reliable "did I create it" signal without a second query.
    const isNew = row.firstSeenAt.getTime() === now.getTime();
    const contentChanged = !isNew && row.contentUpdatedAt?.getTime() === now.getTime();

    /**
     * Append the metric observation.
     *
     * UNIQUE(media_id, sync_run_id) plus DO NOTHING is what makes the consumer
     * idempotent: a redelivered SQS message re-runs this and conflicts instead of
     * doubling the time series.
     */
    await tx
      .insert(mediaMetricSnapshots)
      .values({
        mediaId: row.id,
        syncRunId,
        likeCount: media.like_count ?? null,
        commentsCount: media.comments_count ?? null,
        // Rank is only a popularity signal on top_media; on recent_media the
        // ordering is chronological and a number here would be misleading.
        rank: source === 'top' ? rank : null,
        source,
        capturedAt: now,
      })
      .onConflictDoNothing({
        target: [mediaMetricSnapshots.mediaId, mediaMetricSnapshots.syncRunId],
      });

    const entities = parseCaptionEntities(media.caption);

    if (entities.length > 0) {
      await tx
        .insert(mediaCaptionEntities)
        .values(entities.map((entity) => ({ mediaId: row.id, ...entity })))
        .onConflictDoNothing({
          target: [
            mediaCaptionEntities.mediaId,
            mediaCaptionEntities.type,
            mediaCaptionEntities.value,
          ],
        });
    }

    return { id: row.id, isNew, contentChanged };
  });
}

export async function findByIgMediaId(igMediaId: string): Promise<HashtagMedia | undefined> {
  const rows = await db
    .select()
    .from(hashtagMedia)
    .where(eq(hashtagMedia.igMediaId, igMediaId))
    .limit(1);

  return rows[0];
}

export async function findById(id: string): Promise<HashtagMedia | undefined> {
  const rows = await db.select().from(hashtagMedia).where(eq(hashtagMedia.id, id)).limit(1);
  return rows[0];
}

/**
 * Flags media that has not been seen for a while.
 *
 * A post can vanish from responses because it was deleted, made private, or
 * simply fell out of the top set. We cannot distinguish those, so this is a soft
 * flag and never a DELETE: the metric history and the stored asset remain valid
 * and are the only record that the post ever existed.
 */
export async function markStaleBefore(hashtagId: string, threshold: Date): Promise<number> {
  const result = await db
    .update(hashtagMedia)
    .set({ isStale: true, updatedAt: new Date() })
    .where(
      and(
        eq(hashtagMedia.hashtagId, hashtagId),
        lt(hashtagMedia.lastSeenAt, threshold),
        eq(hashtagMedia.isStale, false),
      ),
    )
    .returning({ id: hashtagMedia.id });

  return result.length;
}
