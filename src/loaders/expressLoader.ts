import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { hashtagRouter } from '../api/controllers/HashtagController';
import { healthRouter } from '../api/controllers/HealthController';
import { errorHandler, notFoundHandler } from '../api/middlewares/errorHandler';

/**
 * Builds the Express app.
 *
 * Kept as a function returning the app - rather than a module that starts
 * listening on import - so tests can exercise routes without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  app.use(
    pinoHttp({
      logger,
      // Health checks are polled constantly; logging them at info drowns
      // everything that matters.
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) {
          return 'error';
        }
        if (res.statusCode >= 400) {
          return 'warn';
        }
        return 'debug';
      },
    }),
  );

  // Health sits outside the version prefix so probes never need updating when
  // the API version changes.
  app.use(healthRouter);

  const api = express.Router();
  api.use(hashtagRouter);
  app.use(env.APP_ROUTE_PREFIX, api);

  // Also mounted unprefixed, because the brief specifies the path as
  // `GET /hashtags`. Serving it only at /api/v1/hashtags would technically not be
  // the endpoint that was asked for.
  app.use(hashtagRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
