import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { componentLogger } from '../../lib/logger';
import { isProduction } from '../../lib/env';
import { ApiError } from '../errors/ApiError';

const log = componentLogger('http');

/** 404 for unmatched routes, so the error shape is consistent everywhere. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}` },
  });
}

/**
 * Terminal error handler. Express identifies these by arity, so `next` must stay
 * in the signature even though it is unused.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    // Query/param validation failures are the client's problem, not ours - 400
    // with the field-level detail so the caller can fix the request.
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof ApiError) {
    // Expected, classified failures: log at warn and return the carried status.
    log.warn({ err: error, code: error.code }, 'request failed');
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  // Anything else is a bug. Log the full error, but do not leak internals to the
  // client in production.
  log.error({ err: error }, 'unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction
        ? 'Internal server error'
        : error instanceof Error
          ? error.message
          : String(error),
    },
  });
}
