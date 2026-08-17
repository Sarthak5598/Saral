import { setActive } from '../src/api/repositories/HashtagRepository';
import { componentLogger } from '../src/lib/logger';
import { requireArg, runCommand } from './_runner';

const log = componentLogger('cmd:hashtag:untrack');

/**
 * Stops syncing a hashtag.
 *
 *   pnpm hashtag:untrack coffee
 *
 * Sets is_active = false rather than deleting. Everything already collected -
 * media, the metric time series, the stored assets - stays queryable, because it
 * is historical data that cannot be re-fetched: Meta's quota is capped and old
 * media_urls have expired. The scheduler simply stops selecting the row.
 */
runCommand('hashtag:untrack', async () => {
  const name = requireArg(0, 'pnpm hashtag:untrack <name>');

  const hashtag = await setActive(name, false);

  if (!hashtag) {
    throw new Error(`hashtag "${name}" is not tracked`);
  }

  log.info(
    { hashtag: hashtag.name, id: hashtag.id },
    'hashtag deactivated - existing data retained, no further syncs scheduled',
  );
});
