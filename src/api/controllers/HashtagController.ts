import { Router } from 'express';

import { getStorage } from '../../adapters/index';
import { NotFoundError } from '../errors/ApiError';
import { findByName } from '../repositories/HashtagRepository';
import * as HashtagMediaQueryRepository from '../repositories/HashtagMediaQueryRepository';
import { listHashtagMediaQuerySchema } from './requests/listHashtagMediaRequest';
import { decodeCursor, encodeCursor } from './responses/cursor';

export const hashtagRouter = Router();

/**
 * GET /hashtags - the one paginated read API the brief asks for.
 *
 * Returns stored media newest post first, using keyset pagination.
 *
 * Query parameters:
 *   hashtag       filter to one tracked hashtag (default: all)
 *   limit         1-100, default 25
 *   cursor        opaque cursor from a previous response's nextCursor
 *   mediaType     IMAGE | VIDEO | CAROUSEL_ALBUM
 *   takenAfter    ISO date - filter on the post's own timestamp
 *   takenBefore   ISO date
 *   includeStale  include posts that stopped appearing (default true)
 *   includeAsset  include stored-asset details (default true)
 *
 * "Descending order of creation time" is read as the post's own `taken_at`, not our
 * `created_at`. Those diverge sharply here: a top_media sync ingests months-old
 * popular posts, so ordering by ingestion time would interleave old posts among new
 * ones purely by when we happened to fetch them. Sorting by `taken_at` is the order
 * a consumer means. Both timestamps are returned so a client can do otherwise.
 */
hashtagRouter.get('/hashtags', async (req, res, next) => {
  try {
    const query = listHashtagMediaQuerySchema.parse(req.query);

    // Distinguish "tag not tracked" from "tag tracked but has no media yet". An
    // empty array for a typo'd hashtag is a confusing answer.
    if (query.hashtag) {
      const hashtag = await findByName(query.hashtag);
      if (!hashtag) {
        throw new NotFoundError(
          `hashtag "${query.hashtag}" is not tracked. Track it with: pnpm hashtag:track ${query.hashtag}`,
        );
      }
    }

    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

    const [{ rows, hasMore }, total] = await Promise.all([
      HashtagMediaQueryRepository.listMedia({
        hashtag: query.hashtag,
        mediaType: query.mediaType,
        takenAfter: query.takenAfter,
        takenBefore: query.takenBefore,
        includeStale: query.includeStale,
        limit: query.limit,
        cursor,
      }),
      HashtagMediaQueryRepository.countMedia({
        hashtag: query.hashtag,
        mediaType: query.mediaType,
        includeStale: query.includeStale,
      }),
    ]);

    const storage = getStorage();
    const last = rows[rows.length - 1];

    res.json({
      data: rows.map((row) => ({
        id: row.id,
        igMediaId: row.igMediaId,
        hashtag: row.hashtagName,
        mediaType: row.mediaType,
        caption: row.caption,
        permalink: row.permalink,

        takenAt: row.takenAt.toISOString(),

        metrics: {
          likeCount: row.likeCount,
          commentsCount: row.commentsCount,
          // Best rank ever observed in a top_media response. Meaningless for media
          // only ever seen via recent_media, hence null there.
          bestTopRank: row.bestTopRank,
        },

        discovery: {
          seenInTop: row.seenInTop,
          seenInRecent: row.seenInRecent,
          firstSeenAt: row.firstSeenAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          // Non-null only when the caption, permalink or type actually changed -
          // not merely because a sync touched the row.
          contentUpdatedAt: row.contentUpdatedAt?.toISOString() ?? null,
          isStale: row.isStale,
        },

        ...(query.includeAsset
          ? {
              asset: row.assetKey
                ? {
                    status: row.assetStatus,
                    storageKey: row.assetKey,
                    // Provider locator (s3:// or a local path), not a public URL -
                    // the bucket is private and serving media is out of scope.
                    locator: storage.getLocator(row.assetKey),
                    sha256: row.assetSha256,
                    sizeBytes: row.assetSizeBytes,
                    contentType: row.assetContentType,
                  }
                : { status: row.assetStatus ?? 'pending' },
            }
          : {}),
      })),

      pagination: {
        limit: query.limit,
        count: rows.length,
        total,
        hasMore,
        // Null on the last page, so a client can loop until it is null rather than
        // comparing counts.
        nextCursor: hasMore && last ? encodeCursor(last.takenAt, last.id) : null,
      },
    });
  } catch (error) {
    next(error);
  }
});
