import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '../../database/client';
import type { RateLimitUsage } from '../../lib/meta/rateLimit';
import type { SyncRun } from '../models';
import { syncRuns } from '../models';

type SyncRunType = 'SYNC_TOP_HASHTAG_MEDIA' | 'SYNC_RECENT_HASHTAG_MEDIA';

export async function startRun(input: {
  type: SyncRunType;
  hashtagId: string;
  messageId?: string;
  attempt?: number;
}): Promise<SyncRun> {
  const [row] = await db
    .insert(syncRuns)
    .values({
      type: input.type,
      hashtagId: input.hashtagId,
      status: 'running',
      triggeredByMessageId: input.messageId ?? null,
      attempts: input.attempt ?? 1,
    })
    .returning();

  if (!row) {
    throw new Error('failed to create sync run');
  }
  return row;
}

/**
 * Finds an unfinished run to resume.
 *
 * This is what makes a retry cheap. Meta's edges accept ~6 items per page and take
 * ~8s each, so a 500-item sync is ~83 requests over ~11 minutes. Restarting from
 * page 1 after a failure on page 70 would re-spend 70 requests of a quota capped
 * at 30 unique hashtags per 7 days - an allowance that cannot be topped up.
 *
 * Only runs still marked `running` qualify: a run that already reached a terminal
 * status has nothing left to resume.
 */
export async function findResumableRun(
  type: SyncRunType,
  hashtagId: string,
): Promise<SyncRun | undefined> {
  const rows = await db
    .select()
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.type, type),
        eq(syncRuns.hashtagId, hashtagId),
        eq(syncRuns.status, 'running'),
      ),
    )
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  return rows[0];
}

/**
 * Records progress after each page is persisted.
 *
 * Called per page rather than once at the end, deliberately: the cursor is only
 * useful if it survives the crash it exists to protect against. Counters are
 * incremented in SQL rather than read-modify-written, so a concurrent update
 * cannot lose a page.
 */
export async function recordPageProgress(
  runId: string,
  delta: {
    itemsSeen: number;
    itemsNew: number;
    itemsUpdated: number;
    metricsRecorded: number;
    assetJobsEnqueued: number;
    lastCursor?: string | undefined;
    rateLimit?: RateLimitUsage | undefined;
  },
): Promise<void> {
  await db
    .update(syncRuns)
    .set({
      pagesFetched: sql`${syncRuns.pagesFetched} + 1`,
      itemsSeen: sql`${syncRuns.itemsSeen} + ${delta.itemsSeen}`,
      itemsNew: sql`${syncRuns.itemsNew} + ${delta.itemsNew}`,
      itemsUpdated: sql`${syncRuns.itemsUpdated} + ${delta.itemsUpdated}`,
      metricsRecorded: sql`${syncRuns.metricsRecorded} + ${delta.metricsRecorded}`,
      assetJobsEnqueued: sql`${syncRuns.assetJobsEnqueued} + ${delta.assetJobsEnqueued}`,
      // NULL means "no further pages" - preserve it rather than clobbering a
      // valid cursor with undefined.
      ...(delta.lastCursor !== undefined ? { lastCursor: delta.lastCursor } : {}),
      ...(delta.rateLimit ? { rateLimitSnapshot: delta.rateLimit as never } : {}),
    })
    .where(eq(syncRuns.id, runId));
}

export async function finishRun(
  runId: string,
  outcome: {
    status: 'succeeded' | 'partial' | 'failed';
    error?: string;
    hitItemCap?: boolean;
  },
): Promise<void> {
  const finishedAt = new Date();

  await db
    .update(syncRuns)
    .set({
      status: outcome.status,
      finishedAt,
      // Computed in SQL against started_at so the duration is the database's
      // view of elapsed time, not a clock read in the application.
      durationMs: sql`EXTRACT(EPOCH FROM (${finishedAt} - ${syncRuns.startedAt})) * 1000`,
      error: outcome.error?.slice(0, 4000) ?? null,
      hitItemCap: outcome.hitItemCap ? 1 : 0,
    })
    .where(eq(syncRuns.id, runId));
}

export async function findById(id: string): Promise<SyncRun | undefined> {
  const rows = await db.select().from(syncRuns).where(eq(syncRuns.id, id)).limit(1);
  return rows[0];
}

/** Recent runs, newest first. Backs the observability story for a reviewer. */
export async function findRecent(limit = 20): Promise<SyncRun[]> {
  return db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(limit);
}
