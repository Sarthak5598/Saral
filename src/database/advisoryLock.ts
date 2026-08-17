import { componentLogger } from '../lib/logger';
import { pool } from './client';

const log = componentLogger('advisory-lock');

/**
 * Runs `fn` while holding a Postgres advisory lock, or skips it if another holder
 * has the lock.
 *
 * This is the last line of defence against concurrent syncs of the same hashtag.
 * Several things can cause that:
 *
 *  - SQS delivers at-least-once, so the same job can arrive twice
 *  - a sync takes ~11 minutes against Meta's slow edges, and if the visibility
 *    heartbeat ever failed the message would be redelivered mid-run
 *  - someone runs `pnpm sync:recent matcha` while the scheduled run is in flight
 *
 * Two concurrent syncs are not catastrophic - the upserts are idempotent - but
 * they double API consumption against a quota that cannot be topped up, so they
 * are worth preventing.
 *
 * Uses pg_try_advisory_lock, not pg_advisory_lock: a blocking wait would hold a
 * worker slot for the duration of the other run. Skipping and letting the next
 * schedule handle it is the better failure mode.
 */
export async function withAdvisoryLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false; result?: undefined }> {
  // Session-scoped locks live on a connection, so the lock and its release must
  // use the same client. Going through the pool's generic query() could route the
  // unlock to a different connection and leak the lock until process exit.
  const client = await pool.connect();

  try {
    const acquire = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked',
      [lockKey],
    );

    if (!acquire.rows[0]?.locked) {
      log.warn({ lockKey }, 'advisory lock held elsewhere, skipping');
      return { acquired: false };
    }

    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      // Must run even if fn throws, or the lock survives until the connection is
      // recycled and blocks every later run.
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockKey])
        .catch((error) => log.error({ err: error, lockKey }, 'failed to release advisory lock'));
    }
  } finally {
    client.release();
  }
}

/** Stable lock key for a hashtag + sync kind. */
export function syncLockKey(hashtagId: string, kind: 'top' | 'recent'): string {
  return `sync:${kind}:${hashtagId}`;
}
