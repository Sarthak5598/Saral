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

/**
 * Meta refused the request because the page was too large - Graph error code 1,
 * "Please reduce the amount of data you're asking for".
 *
 * Its own type because it is recoverable in a specific way: retry the identical
 * cursor with a smaller `limit`. Verified against v24.0, the practical ceiling on
 * these edges is far below the documented 50 and differs per edge (top_media
 * rejected 10, recent_media rejected 25), so the page size has to be negotiated
 * at runtime rather than configured.
 */
export class MetaPayloadTooLargeError extends ApiError {
  constructor(
    message: string,
    readonly attemptedLimit: number,
    details?: unknown,
  ) {
    super(502, 'META_PAYLOAD_TOO_LARGE', message, details);
  }
}
