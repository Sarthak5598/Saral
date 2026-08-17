import { metaMediaSchema } from '../src/lib/meta/types';
import { componentLogger } from '../src/lib/logger';
import * as MediaRepository from '../src/api/repositories/MediaRepository';
import * as DataPointRepository from '../src/api/repositories/DataPointRepository';
import * as SyncRunRepository from '../src/api/repositories/SyncRunRepository';
import { requireArg, runCommand } from './_runner';

const log = componentLogger('cmd:replay');

/**
 * Rebuilds the curated tables for a sync run from the raw payloads it recorded.
 *
 *   pnpm replay <sync_run_id>
 *
 * This is the payoff for the raw landing layer, and the reason it is not merely
 * belt-and-braces. Two Meta constraints make re-fetching impossible rather than
 * just expensive:
 *
 *   - 30 unique hashtags per rolling 7 days, per IG account. The quota cannot be
 *     topped up, so "just run it again" is not available.
 *   - media_url is a signed link that expires within days, so even with quota to
 *     spare the assets behind an old response are gone.
 *
 * So without data_points, a parsing bug found on Friday means last Tuesday's
 * data is lost permanently. With it, the fix costs CPU and nothing else - no API
 * calls, no quota, no network.
 *
 * Safe to re-run: the same idempotent upserts the live path uses.
 */
runCommand('replay', async () => {
  const syncRunId = requireArg(0, 'pnpm replay <sync_run_id>');

  const run = await SyncRunRepository.findById(syncRunId);
  if (!run) {
    throw new Error(`sync run ${syncRunId} not found`);
  }

  const payloads = await DataPointRepository.findByRunId(syncRunId);

  if (payloads.length === 0) {
    throw new Error(`sync run ${syncRunId} recorded no raw payloads - nothing to replay`);
  }

  const source = run.type === 'SYNC_TOP_HASHTAG_MEDIA' ? 'top' : 'recent';

  log.info(
    { syncRunId, type: run.type, payloads: payloads.length },
    'replaying raw payloads into curated tables (no Meta API calls)',
  );

  let reprocessed = 0;
  let created = 0;
  let changed = 0;
  let invalid = 0;

  for (const payload of payloads) {
    // Re-validated rather than trusted: the point of replay is often that the
    // parsing was wrong, so the stored JSON gets the same scrutiny as a live
    // response.
    const parsed = metaMediaSchema.safeParse(payload.payload);

    if (!parsed.success) {
      invalid += 1;
      log.warn(
        { igMediaId: payload.igMediaId, issues: parsed.error.issues.length },
        'stored payload failed validation, skipping',
      );
      continue;
    }

    const result = await MediaRepository.upsertMedia({
      media: parsed.data,
      hashtagId: payload.hashtagId,
      syncRunId,
      source,
      // The original rank is preserved in the raw row, so replay reproduces the
      // ranking rather than inventing a new one from replay order.
      rank: payload.positionOverall + 1,
    });

    reprocessed += 1;
    if (result.isNew) {
      created += 1;
    }
    if (result.contentChanged) {
      changed += 1;
    }
  }

  log.info(
    { syncRunId, reprocessed, created, changed, invalid },
    'replay complete - zero Meta API calls spent',
  );
});
