import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { componentLogger } from '../lib/logger';
import { closeDatabase, db } from './client';

const log = componentLogger('migrate');

/**
 * Applies any pending migrations, then exits.
 *
 * Migrations are explicit and committed - drizzle-kit generates the .sql, and
 * this runner applies it. Nothing auto-syncs the schema from the models, so the
 * database shape is always reviewable in git and identical across machines.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.join(__dirname, 'migrations');

  log.info({ migrationsFolder }, 'applying migrations');
  await migrate(db, { migrationsFolder });
  log.info('migrations up to date');
}

// Only self-execute when invoked directly (`pnpm db:migrate`), so the function
// stays importable from tests and from the app bootstrap.
if (require.main === module) {
  runMigrations()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (error) => {
      log.fatal({ err: error }, 'migration failed');
      await closeDatabase().catch(() => undefined);
      process.exit(1);
    });
}
