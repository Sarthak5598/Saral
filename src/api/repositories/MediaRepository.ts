import { and, desc, eq, lt, sql } from 'drizzle-orm';

import { db } from '../../database/client';
import { parseMetaTimestamp, type MetaMedia } from '../../lib/meta/types';
import { parseCaptionArrays } from '../services/captionParser';
import type { MediaPost } from '../models';
import { mediaPostHistory, mediaPosts } from '../models';

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
  /** True when a history row was written, i.e. some observable value differed. */
  historyRecorded: boolean;
  /** Which fields differed from the previous history row. */
  changedFields: string[];
}

/** Fields compared to decide whether a new history row is warranted. */
const TRACKED_FIELDS = [
  'likeCount',
  'commentsCount',
  'rank',
  'caption',
  'permalink',
  'mediaType',
] as const;

/**
 * Inserts or refreshes one post, and appends a history row if anything observable
 * changed.
 *
 * The whole thing runs in one transaction: a post row whose history row failed to
 * write is a worse outcome than the page failing and being retried.
 */
export async function upsertMedia(input: UpsertMediaInput): Promise<UpsertMediaResult> {
  const { media, hashtagId, syncRunId, source, rank } = input;
  const takenAt = parseMetaTimestamp(media.timestamp);
  const now = new Date();

  const { hashtags: captionHashtags, mentions: captionMentions } = parseCaptionArrays(
    media.caption,
  );

  // Rank is only a popularity signal on top_media; on recent_media the ordering is
  // chronological and a number here would be misleading.
  const effectiveRank = source === 'top' ? rank : null;

  return db.transaction(async (tx) => {
    /**
     * Deduplication happens here, in the database.
     *
     * ON CONFLICT is not a convenience over "SELECT then INSERT if missing" - it is the
     * only correct option. Two workers running the check-then-insert version can both
     * see no row and both insert. That matters because SQS delivers at-least-once, so
     * concurrent processing of the same media is expected rather than exceptional.
     */
    const [row] = await tx
      .insert(mediaPosts)
      .values({
        igMediaId: media.id,
        hashtagId,
        mediaType: media.media_type,
        caption: media.caption ?? null,
        permalink: media.permalink,
        sourceMediaUrl: media.media_url ?? null,
        captionHashtags,
        captionMentions,
        takenAt,
        firstSeenAt: now,
        lastSeenAt: now,
        likeCount: media.like_count ?? null,
        commentsCount: media.comments_count ?? null,
        metricsUpdatedAt: now,
        firstSeenVia: source,
        seenInTop: source === 'top',
        seenInRecent: source === 'recent',
        bestTopRank: effectiveRank,
      })
      .onConflictDoUpdate({
        target: mediaPosts.igMediaId,
        set: {
          // Refreshed every time - these are current observations.
          caption: media.caption ?? null,
          sourceMediaUrl: media.media_url ?? null,
          captionHashtags,
          captionMentions,
          likeCount: media.like_count ?? null,
          commentsCount: media.comments_count ?? null,
          metricsUpdatedAt: now,
          lastSeenAt: now,
          updatedAt: now,

          // Sticky flags: once seen in an edge, always seen in it. OR-ing rather than
          // assigning preserves the fact that a post has appeared in both.
          seenInTop: sql`${mediaPosts.seenInTop} OR ${source === 'top'}`,
          seenInRecent: sql`${mediaPosts.seenInRecent} OR ${source === 'recent'}`,

          // Best rank means numerically lowest. LEAST ignores NULLs, so a first
          // top_media sighting sets it correctly.
          bestTopRank:
            source === 'top'
              ? sql`LEAST(${mediaPosts.bestTopRank}, ${rank})`
              : sql`${mediaPosts.bestTopRank}`,

          // Reappearing clears the stale flag.
          isStale: sql`false`,

          /**
           * Only bumped when durable content actually differs. Setting this
           * unconditionally would mark every row as freshly edited on every sync,
           * destroying the ability to find genuinely edited captions. Metric changes
           * deliberately do not count - they belong to the history table.
           */
          contentUpdatedAt: sql`
            CASE WHEN ${mediaPosts.caption} IS DISTINCT FROM ${media.caption ?? null}
                   OR ${mediaPosts.permalink} IS DISTINCT FROM ${media.permalink}
                   OR ${mediaPosts.mediaType} IS DISTINCT FROM ${media.media_type}::media_type
                 THEN ${now}
                 ELSE ${mediaPosts.contentUpdatedAt}
            END
          `,
        },
      })
      .returning({
        id: mediaPosts.id,
        firstSeenAt: mediaPosts.firstSeenAt,
        contentUpdatedAt: mediaPosts.contentUpdatedAt,
      });

    if (!row) {
      throw new Error(`upsert returned no row for media ${media.id}`);
    }

    // firstSeenAt is only ever written on insert, so equality with this run's timestamp
    // is a reliable "did I create it" signal without a second query.
    const isNew = row.firstSeenAt.getTime() === now.getTime();
    const contentChanged = !isNew && row.contentUpdatedAt?.getTime() === now.getTime();

    /**
     * Append a history row only if something observable changed.
     *
     * The comparison is against the single most recent history row, fetched inside the
     * transaction. Most syncs re-observe identical values on older posts, so writing
     * every observation would be overwhelmingly duplicate rows.
     *
     * The cost is that a gap in history no longer distinguishes "unchanged" from "not
     * checked" - sync_runs resolves that, since it records every run and the hashtag it
     * covered.
     */
    const [previous] = await tx
      .select({
        likeCount: mediaPostHistory.likeCount,
        commentsCount: mediaPostHistory.commentsCount,
        rank: mediaPostHistory.rank,
        caption: mediaPostHistory.caption,
        permalink: mediaPostHistory.permalink,
        mediaType: mediaPostHistory.mediaType,
      })
      .from(mediaPostHistory)
      .where(eq(mediaPostHistory.mediaId, row.id))
      .orderBy(desc(mediaPostHistory.capturedAt))
      .limit(1);

    const current = {
      likeCount: media.like_count ?? null,
      commentsCount: media.comments_count ?? null,
      rank: effectiveRank,
      caption: media.caption ?? null,
      permalink: media.permalink,
      mediaType: media.media_type,
    };

    // No previous row means this is the first observation - always worth recording.
    const changedFields = previous
      ? TRACKED_FIELDS.filter((field) => previous[field] !== current[field])
      : [...TRACKED_FIELDS];

    let historyRecorded = false;

    if (changedFields.length > 0) {
      const inserted = await tx
        .insert(mediaPostHistory)
        .values({
          mediaId: row.id,
          hashtagId,
          syncRunId,
          igMediaId: media.id,
          mediaType: media.media_type,
          caption: media.caption ?? null,
          permalink: media.permalink,
          captionHashtags,
          captionMentions,
          likeCount: media.like_count ?? null,
          commentsCount: media.comments_count ?? null,
          rank: effectiveRank,
          source,
          changedFields: [...changedFields],
          capturedAt: now,
        })
        // UNIQUE(media_id, sync_run_id): a redelivered SQS message re-runs this and
        // conflicts instead of doubling the history.
        .onConflictDoNothing({
          target: [mediaPostHistory.mediaId, mediaPostHistory.syncRunId],
        })
        .returning({ id: mediaPostHistory.id });

      historyRecorded = inserted.length > 0;
    }

    return { id: row.id, isNew, contentChanged, historyRecorded, changedFields: [...changedFields] };
  });
}

export async function findByIgMediaId(igMediaId: string): Promise<MediaPost | undefined> {
  const rows = await db
    .select()
    .from(mediaPosts)
    .where(eq(mediaPosts.igMediaId, igMediaId))
    .limit(1);

  return rows[0];
}

export async function findById(id: string): Promise<MediaPost | undefined> {
  const rows = await db.select().from(mediaPosts).where(eq(mediaPosts.id, id)).limit(1);
  return rows[0];
}

/**
 * Flags posts not seen for a while.
 *
 * A post can vanish because it was deleted, made private, or simply fell out of the top
 * set. We cannot distinguish those, so this is a soft flag and never a DELETE: the
 * history and the stored file remain valid and are the only record it ever existed.
 */
export async function markStaleBefore(hashtagId: string, threshold: Date): Promise<number> {
  const result = await db
    .update(mediaPosts)
    .set({ isStale: true, updatedAt: new Date() })
    .where(
      and(
        eq(mediaPosts.hashtagId, hashtagId),
        lt(mediaPosts.lastSeenAt, threshold),
        eq(mediaPosts.isStale, false),
      ),
    )
    .returning({ id: mediaPosts.id });

  return result.length;
}

/**
 * Hashtag co-occurrence, straight off the array column.
 *
 * The question this answers - "what else do people tag alongside #matcha?" - is the
 * main reason captions are parsed at all, since Meta provides no owner or location data.
 */
export async function findCoOccurringHashtags(
  hashtagId: string,
  limit = 20,
): Promise<Array<{ tag: string; posts: number }>> {
  const rows = await db.execute<{ tag: string; posts: number }>(sql`
    SELECT tag, count(*)::int AS posts
    FROM ${mediaPosts}, unnest(${mediaPosts.captionHashtags}) AS tag
    WHERE ${mediaPosts.hashtagId} = ${hashtagId}
    GROUP BY tag
    ORDER BY posts DESC
    LIMIT ${limit}
  `);

  return rows.rows;
}
