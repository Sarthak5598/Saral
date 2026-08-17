import { Router } from 'express';

import { checkDatabaseConnection } from '../../database/client';
import { env } from '../../lib/env';

export const healthRouter = Router();

/**
 * Liveness + readiness in one endpoint.
 *
 * Reports which drivers are active, because "is it using SQS or the in-memory
 * queue right now?" is the first question anyone asks when jobs are not running,
 * and guessing from config files is slower than asking the process.
 */
healthRouter.get('/health', async (_req, res) => {
  const databaseUp = await checkDatabaseConnection();

  res.status(databaseUp ? 200 : 503).json({
    status: databaseUp ? 'ok' : 'degraded',
    checks: { database: databaseUp ? 'up' : 'down' },
    drivers: {
      queue: env.QUEUE_DRIVER,
      storage: env.STORAGE_DRIVER,
      scheduler: env.SCHEDULER_DRIVER,
    },
    uptimeSeconds: Math.round(process.uptime()),
  });
});
