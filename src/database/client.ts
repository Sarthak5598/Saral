import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from '../api/models';
import { env } from '../lib/env';
import { componentLogger } from '../lib/logger';

const log = componentLogger('database');

/**
 * A single pool per process, shared by the API and the worker.
 *
 * The connection string is the only thing that has to change to move from the
 * Docker Postgres to RDS - no code edits, which is the point of keeping it in
 * one env var.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  // Fail fast rather than hanging a job for minutes on an unreachable database.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (error) => {
  // An idle client erroring out is recoverable - pg will replace it - but it is
  // worth knowing about, because a flood of these means the database is unhealthy.
  log.error({ err: error }, 'idle postgres client error');
});

export const db = drizzle(pool, { schema, logger: false });

export type Database = typeof db;

/** Cheap liveness probe used by GET /health and by the worker before polling. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    log.error({ err: error }, 'database connection check failed');
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
  log.info('postgres pool closed');
}
