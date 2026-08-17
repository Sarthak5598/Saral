import { closeAdapters } from '../src/adapters/index';
import { closeDatabase } from '../src/database/client';
import { componentLogger } from '../src/lib/logger';

/**
 * Shared bootstrap for the CLI commands.
 *
 * Every command needs the same three things: run the body, release the pool and
 * driver clients, and exit with a code that reflects what happened. Without the
 * explicit close, an open pg pool keeps the event loop alive and the command hangs
 * after printing its result.
 */
export function runCommand(name: string, body: () => Promise<void>): void {
  const log = componentLogger(`cmd:${name}`);

  body()
    .then(async () => {
      await closeAdapters();
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (error) => {
      log.fatal({ err: error }, `${name} failed`);
      await closeAdapters().catch(() => undefined);
      await closeDatabase().catch(() => undefined);
      process.exit(1);
    });
}

/** Reads a positional argument, erroring with usage rather than a stack trace. */
export function requireArg(index: number, usage: string): string {
  const value = process.argv[2 + index];

  if (!value) {
    // eslint-disable-next-line no-console
    console.error(`\n  Usage: ${usage}\n`);
    process.exit(1);
  }

  return value;
}

export function optionalArg(index: number): string | undefined {
  return process.argv[2 + index];
}
