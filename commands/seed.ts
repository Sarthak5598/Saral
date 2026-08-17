import { closeDatabase } from '../src/database/client';
import { runMigrations } from '../src/database/migrate';
import { ensureTracked } from '../src/api/repositories/HashtagRepository';
import { componentLogger } from '../src/lib/logger';

const log = componentLogger('seed');

/**
 * Seeds the hashtag the assignment asks us to track.
 *
 * `matcha` is a row, not a constant - this seed just makes the system useful out
 * of the box. Tracking another tag is `pnpm hashtag:track <name>`, with no code
 * change and no redeploy, because the scheduler reads from this table.
 *
 * Idempotent: safe to run repeatedly.
 */
async function main(): Promise<void> {
  await runMigrations();

  const hashtag = await ensureTracked({
    name: 'matcha',
    notes: 'Seeded by pnpm db:seed - the tag required by the assignment brief.',
  });

  log.info(
    { id: hashtag.id, name: hashtag.name, igHashtagId: hashtag.igHashtagId },
    'hashtag tracked',
  );

  if (!hashtag.igHashtagId) {
    log.info('ig_hashtag_id not resolved yet - the first sync will resolve and cache it');
  }
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (error) => {
    log.fatal({ err: error }, 'seed failed');
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
