/**
 * Errors that carry an HTTP status and a stable machine-readable code.
 *
 * The code matters more than the message: clients switch on `code`, humans read
 * `message`. Keeping them separate means the wording can change without breaking
 * a consumer.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(404, 'NOT_FOUND', message, details);
  }
}

/**
 * Raised when Meta rejects the access token (Graph error code 190).
 *
 * Called out as its own type because it is the pipeline's most dangerous failure
 * mode: an expired token makes every sync return zero items, which looks
 * identical to "no new posts" unless it is surfaced loudly.
 */
export class MetaAuthError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(502, 'META_AUTH_FAILED', message, details);
  }
}

/** Meta rate limit hit - the caller should back off, not retry immediately. */
export class MetaRateLimitError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(429, 'META_RATE_LIMITED', message, details);
  }
}
