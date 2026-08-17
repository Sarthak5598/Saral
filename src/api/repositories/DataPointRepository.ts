import { asc, eq } from 'drizzle-orm';

import { db } from '../../database/client';
import type { MetaMedia } from '../../lib/meta/types';
import type { DataPoint } from '../models';
import { dataPoints } from '../models';

/**
 * Writes to the raw landing layer (data_points).
 *
 * Append-only and never deduplicated. The same post appearing on three
 * consecutive runs correctly produces three rows - the table records what Meta
 * said at a point in time, which is exactly what makes it useful for replay.
 */
export async function recordPage(input: {
  syncRunId: string;
  hashtagId: string;
  source: 'top' | 'recent';
  pageNumber: number;
  /** Count of items already stored in this run, for absolute positions. */
  offset: number;
  items: MetaMedia[];
}): Promise<void> {
  if (input.items.length === 0) {
    return;
  }

  await db.insert(dataPoints).values(
    input.items.map((item, index) => ({
      syncRunId: input.syncRunId,
      hashtagId: input.hashtagId,
      igMediaId: item.id,
      source: input.source,
      pageNumber: input.pageNumber,
      positionInPage: index,
      positionOverall: input.offset + index,
      // Stored whole and unparsed. If a field turns out to matter later, it is
      // already here - which is the difference between a fixable mistake and an
      // unrecoverable one, given media_url expires and quota is capped.
      payload: item as never,
    })),
  );
}

/**
 * Every raw payload for a run, in the order Meta returned it.
 *
 * Backs `pnpm replay`: the curated tables can be rebuilt from here without a
 * single API call, so a parsing bug costs nothing but CPU to fix retroactively.
 */
export async function findByRunId(syncRunId: string): Promise<DataPoint[]> {
  return db
    .select()
    .from(dataPoints)
    .where(eq(dataPoints.syncRunId, syncRunId))
    .orderBy(asc(dataPoints.positionOverall));
}

export async function countByRunId(syncRunId: string): Promise<number> {
  const rows = await db
    .select({ count: dataPoints.id })
    .from(dataPoints)
    .where(eq(dataPoints.syncRunId, syncRunId));

  return rows.length;
}
