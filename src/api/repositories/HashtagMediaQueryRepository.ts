import { and, desc, eq, gte, lte, lt, or, sql, type SQL } from 'drizzle-orm';

import { db } from '../../database/client';
import { hashtags, mediaAssets, mediaPosts } from '../models';

export interface ListMediaFilters {
  hashtag?: string | undefined;
  mediaType?: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | undefined;
  takenAfter?: Date | undefined;
  takenBefore?: Date | undefined;
  includeStale: boolean;
  limit: number;
  cursor?: { takenAt: Date; id: string } | undefined;
}

export interface ListMediaRow {
  id: string;
  igMediaId: string;
  hashtagName: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  caption: string | null;
  captionHashtags: string[] | null;
  captionMentions: string[] | null;
  permalink: string;
  takenAt: Date;
  likeCount: number | null;
  commentsCount: number | null;
  bestTopRank: number | null;
  seenInTop: boolean;
  seenInRecent: boolean;
  isStale: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  contentUpdatedAt: Date | null;
  assetStatus: string | null;
  assetKey: string | null;
  assetSha256: string | null;
  assetSizeBytes: number | null;
  assetContentType: string | null;
}

/**
 * Reads stored media, newest post first, using keyset pagination.
 *
 * The ordering is (taken_at DESC, id DESC) and is backed by
 * media_posts_hashtag_taken_at_idx. `id` is in the sort key because Instagram
 * timestamps are not unique - without it the ordering is not total, and a cursor
 * built on a duplicated timestamp would either repeat or skip rows.
 */
export async function listMedia(
  filters: ListMediaFilters,
): Promise<{ rows: ListMediaRow[]; hasMore: boolean }> {
  const conditions: SQL[] = [];

  if (filters.hashtag) {
    conditions.push(eq(hashtags.name, filters.hashtag.replace(/^#+/, '').toLowerCase()));
  }

  if (filters.mediaType) {
    conditions.push(eq(mediaPosts.mediaType, filters.mediaType));
  }

  if (filters.takenAfter) {
    conditions.push(gte(mediaPosts.takenAt, filters.takenAfter));
  }

  if (filters.takenBefore) {
    conditions.push(lte(mediaPosts.takenAt, filters.takenBefore));
  }

  if (!filters.includeStale) {
    conditions.push(eq(mediaPosts.isStale, false));
  }

  /**
   * The keyset predicate: strictly after the cursor in (taken_at, id) DESC order.
   *
   * Expressed as a row comparison rather than `taken_at < cursor`, which would drop
   * every other row sharing that exact timestamp.
   */
  if (filters.cursor) {
    conditions.push(
      or(
        lt(mediaPosts.takenAt, filters.cursor.takenAt),
        and(
          eq(mediaPosts.takenAt, filters.cursor.takenAt),
          lt(mediaPosts.id, filters.cursor.id),
        ),
      ) as SQL,
    );
  }

  // Fetch one extra row to determine hasMore without a second COUNT query, which
  // on a growing table would be both slower and potentially inconsistent with the
  // page just returned.
  const rows = await db
    .select({
      id: mediaPosts.id,
      igMediaId: mediaPosts.igMediaId,
      hashtagName: hashtags.name,
      mediaType: mediaPosts.mediaType,
      caption: mediaPosts.caption,
      captionHashtags: mediaPosts.captionHashtags,
      captionMentions: mediaPosts.captionMentions,
      permalink: mediaPosts.permalink,
      takenAt: mediaPosts.takenAt,
      likeCount: mediaPosts.likeCount,
      commentsCount: mediaPosts.commentsCount,
      bestTopRank: mediaPosts.bestTopRank,
      seenInTop: mediaPosts.seenInTop,
      seenInRecent: mediaPosts.seenInRecent,
      isStale: mediaPosts.isStale,
      firstSeenAt: mediaPosts.firstSeenAt,
      lastSeenAt: mediaPosts.lastSeenAt,
      contentUpdatedAt: mediaPosts.contentUpdatedAt,
      assetStatus: mediaAssets.status,
      assetKey: mediaAssets.storageKey,
      assetSha256: mediaAssets.sha256,
      assetSizeBytes: mediaAssets.sizeBytes,
      assetContentType: mediaAssets.contentType,
    })
    .from(mediaPosts)
    .innerJoin(hashtags, eq(hashtags.id, mediaPosts.hashtagId))
    // LEFT so media whose download failed or is pending still appears - hiding it
    // would misrepresent what has been collected.
    .leftJoin(mediaAssets, eq(mediaAssets.mediaId, mediaPosts.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(mediaPosts.takenAt), desc(mediaPosts.id))
    .limit(filters.limit + 1);

  const hasMore = rows.length > filters.limit;

  return { rows: (hasMore ? rows.slice(0, filters.limit) : rows) as ListMediaRow[], hasMore };
}

/** Total matching rows, for the metadata block. */
export async function countMedia(
  filters: Pick<ListMediaFilters, 'hashtag' | 'mediaType' | 'includeStale'>,
): Promise<number> {
  const conditions: SQL[] = [];

  if (filters.hashtag) {
    conditions.push(eq(hashtags.name, filters.hashtag.replace(/^#+/, '').toLowerCase()));
  }
  if (filters.mediaType) {
    conditions.push(eq(mediaPosts.mediaType, filters.mediaType));
  }
  if (!filters.includeStale) {
    conditions.push(eq(mediaPosts.isStale, false));
  }

  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(mediaPosts)
    .innerJoin(hashtags, eq(hashtags.id, mediaPosts.hashtagId))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return row?.total ?? 0;
}
