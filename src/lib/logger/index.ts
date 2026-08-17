import pino from 'pino';

import { env } from '../env';

/**
 * Structured logging. Every log line from a sync run carries the same
 * `syncRunId`, so a single grep reconstructs one run end to end - which matters
 * a lot more than pretty output once the worker is processing jobs concurrently.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  // Redact anything that could leak the Meta token or AWS credentials into logs.
  redact: {
    paths: [
      'access_token',
      'accessToken',
      '*.access_token',
      '*.accessToken',
      'req.headers.authorization',
      'url',
    ],
    censor: '[redacted]',
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.LOG_OUTPUT === 'dev'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

/** Child logger tagged with a component name, e.g. `logger.child({ component })`. */
export function componentLogger(component: string) {
  return logger.child({ component });
}
