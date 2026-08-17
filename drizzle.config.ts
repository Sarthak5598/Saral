import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads this to diff the schema in src/api/models against the
 * migrations folder and emit plain .sql files. Migrations are committed and
 * applied explicitly (see src/database/migrate.ts) - never auto-synced, so the
 * database shape is always something a reviewer can read in git.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/api/models/index.ts',
  out: './src/database/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5434/hashtag_media',
  },
  verbose: true,
  strict: true,
});
