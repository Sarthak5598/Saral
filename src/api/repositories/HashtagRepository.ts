import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import { db } from '../../database/client';
import type { Hashtag } from '../models';
import { hashtags } from '../models';

/**
 * Data access for tracked hashtags. Kept as a thin module of functions rather
 * than a class - there is no state to hold, and services import what they need.
 */

/** Lowercase and strip a leading '#', so '#Matcha' and 'matcha' are one tag. */
export function normalizeHashtagName(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase();
}

export async function findByName(name: string): Promise<Hashtag | undefined> {
  const rows = await db
    .select()
    .from(hashtags)
    .where(eq(hashtags.name, normalizeHashtagName(name)))
    .limit(1);

  return rows[0];
}

export async function findById(id: string): Promise<Hashtag | undefined> {
  const rows = await db.select().from(hashtags).where(eq(hashtags.id, id)).limit(1);
  return rows[0];
}

/**
 * Insert the hashtag if absent, otherwise leave the existing row alone and
 * return it. Deliberately does not overwrite tracking config - re-running
 * `pnpm hashtag:track matcha` should be a no-op, not a reset of the window and
 * sync flags someone set on purpose.
 */
export async function ensureTracked(input: {
  name: string;
  trackFrom?: Date | null;
  trackUntil?: Date | null;
  notes?: string | null;
}): Promise<Hashtag> {
  const name = normalizeHashtagName(input.name);

  const [row] = await db
    .insert(hashtags)
    .values({
      name,
      trackFrom: input.trackFrom ?? null,
      trackUntil: input.trackUntil ?? null,
      notes: input.notes ?? null,
    })
    .onConflictDoUpdate({
      target: hashtags.name,
      // Touching updated_at gives the upsert something to write so it reliably
      // returns the row, without mutating any meaningful field.
      set: { updatedAt: new Date() },
    })
    .returning();

  // The upsert always returns exactly one row; the check keeps TypeScript honest
  // under noUncheckedIndexedAccess.
  if (!row) {
    throw new Error(`failed to upsert hashtag "${name}"`);
  }

  return row;
}

/**
 * Cache Meta's hashtag ID after resolving it.
 *
 * This is quota management, not speed: Meta permits only 30 *unique* hashtags per
 * rolling 7 days per IG account, so re-resolving on every sync would eventually
 * hard-fail the pipeline.
 */
export async function setIgHashtagId(id: string, igHashtagId: string): Promise<void> {
  await db
    .update(hashtags)
    .set({
      igHashtagId,
      igHashtagIdResolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(hashtags.id, id));
}

/**
 * The hashtags a scheduled sync should act on: active, inside their tracking
 * window, and with this sync kind enabled.
 *
 * Note the window gates *whether we sync*, not which media is kept - discarding
 * media already paid for in API quota would be unrecoverable. Filtering posts by
 * age is a read-time concern.
 */
export async function findDueForSync(
  kind: 'top' | 'recent',
  now: Date = new Date(),
): Promise<Hashtag[]> {
  const kindEnabled = kind === 'top' ? hashtags.topSyncEnabled : hashtags.recentSyncEnabled;

  return db
    .select()
    .from(hashtags)
    .where(
      and(
        eq(hashtags.isActive, true),
        eq(kindEnabled, true),
        or(isNull(hashtags.trackFrom), lte(hashtags.trackFrom, now)),
        or(isNull(hashtags.trackUntil), sql`${hashtags.trackUntil} >= ${now}`),
      ),
    );
}

export async function setActive(name: string, isActive: boolean): Promise<Hashtag | undefined> {
  const [row] = await db
    .update(hashtags)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(hashtags.name, normalizeHashtagName(name)))
    .returning();

  return row;
}

export async function markSyncSucceeded(id: string, kind: 'top' | 'recent'): Promise<void> {
  await db
    .update(hashtags)
    .set({
      ...(kind === 'top' ? { lastTopSyncedAt: new Date() } : { lastRecentSyncedAt: new Date() }),
      consecutiveFailures: 0,
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(hashtags.id, id));
}

/**
 * Increment rather than assign, so concurrent workers cannot lose a failure
 * count by both reading 2 and both writing 3.
 */
export async function markSyncFailed(id: string, error: string): Promise<void> {
  await db
    .update(hashtags)
    .set({
      consecutiveFailures: sql`${hashtags.consecutiveFailures} + 1`,
      lastSyncError: error.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(hashtags.id, id));
}

/** Hashtags that have been resolved against Meta at least once. */
export async function findResolved(): Promise<Hashtag[]> {
  return db.select().from(hashtags).where(isNotNull(hashtags.igHashtagId));
}
