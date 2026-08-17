import type { Server } from 'node:http';

import { createApp } from './loaders/expressLoader';
import { closeDatabase, checkDatabaseConnection } from './database/client';
import { env } from './lib/env';
import { componentLogger } from './lib/logger';

const log = componentLogger('api');

async function main(): Promise<void> {
  // Refuse to serve traffic without a database. Starting anyway would mean every
  // request 500s while the process reports itself healthy.
  if (!(await checkDatabaseConnection())) {
    throw new Error(`cannot reach Postgres - check DATABASE_URL and that Docker is up`);
  }

  const app = createApp();

  const server: Server = app.listen(env.APP_PORT, () => {
    log.info(
      {
        port: env.APP_PORT,
        routePrefix: env.APP_ROUTE_PREFIX,
        drivers: {
          queue: env.QUEUE_DRIVER,
          storage: env.STORAGE_DRIVER,
          scheduler: env.SCHEDULER_DRIVER,
        },
      },
      'api listening',
    );
  });

  /**
   * Graceful shutdown: stop accepting connections, let in-flight requests finish,
   * then release the pool. Without this, a redeploy drops live requests and leaves
   * Postgres holding connections until they time out.
   */
  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');

    const forced = setTimeout(() => {
      log.error('shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);
    // Do not let the timer itself keep the process alive.
    forced.unref();

    server.close(async (error) => {
      if (error) {
        log.error({ err: error }, 'error closing http server');
      }
      await closeDatabase().catch((err) => log.error({ err }, 'error closing database'));
      clearTimeout(forced);
      process.exit(error ? 1 : 0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  log.fatal({ err: error }, 'failed to start api');
  process.exit(1);
});
