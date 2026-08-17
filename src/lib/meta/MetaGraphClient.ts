import {
  ApiError,
  MetaAuthError,
  MetaPayloadTooLargeError,
  MetaRateLimitError,
} from '../../api/errors/ApiError';
import { env } from '../env';
import { componentLogger } from '../logger';
import { parseRateLimitHeaders, throttleDelayMs, type RateLimitUsage } from './rateLimit';
import {
  MEDIA_FIELDS,
  metaErrorResponseSchema,
  metaHashtagSearchResponseSchema,
  metaMediaResponseSchema,
  type MetaMedia,
} from './types';

const log = componentLogger('meta-client');

/** Graph API error codes that mean "the token is bad", never "try again". */
const AUTH_ERROR_CODES = new Set([190, 102, 463, 467]);

/** Graph API error codes that mean throttled. */
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613, 80004]);

export interface MediaPage {
  items: MetaMedia[];
  pageNumber: number;
  /** Cursor for the following page, absent on the last page. */
  nextCursor?: string;
  rateLimit?: RateLimitUsage;
}

export interface PaginateOptions {
  hashtagId: string;
  edge: 'top_media' | 'recent_media';
  /** Stops once this many items have been yielded across all pages. */
  maxItems: number;
  pageSize?: number;
  signal?: AbortSignal;
}

interface RequestResult<T> {
  body: T;
  rateLimit?: RateLimitUsage;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Client for the Instagram hashtag endpoints of the Meta Graph API.
 *
 * Responsibilities kept here on purpose: URL construction, retries, error
 * classification and rate-limit backoff. It knows nothing about Postgres or
 * queues, so it can be unit tested against recorded fixtures.
 */
export class MetaGraphClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly igUserId: string;

  /**
   * Usage from the most recent response, carried between calls so a request can
   * back off based on what the previous one reported.
   */
  private lastRateLimit?: RateLimitUsage;

  /**
   * Page size Meta was last observed to accept, per edge.
   *
   * Negotiating down costs a wasted round trip per halving, and these edges take
   * ~8s to respond - so re-probing 25 -> 12 -> 6 on every sync would burn ~16s
   * and two API calls each time for a value that does not change between runs.
   * Remembering it makes the negotiation a one-off per process.
   *
   * Held in memory rather than persisted: it is a property of Meta's current
   * behaviour, not of our data, and starting fresh after a restart is cheap and
   * self-correcting.
   */
  private readonly learnedPageSize = new Map<string, number>();

  constructor(options?: { accessToken?: string; igUserId?: string; baseUrl?: string }) {
    this.accessToken = options?.accessToken ?? env.META_ACCESS_TOKEN;
    this.igUserId = options?.igUserId ?? env.META_IG_USER_ID;
    this.baseUrl = `${options?.baseUrl ?? env.META_API_BASE_URL}/${env.META_GRAPH_VERSION}`;
  }

  getLastRateLimit(): RateLimitUsage | undefined {
    return this.lastRateLimit;
  }

  /**
   * Resolves a hashtag name to Meta's opaque hashtag ID.
   *
   * Callers should cache the result (see hashtags.ig_hashtag_id). Meta counts
   * *unique hashtags queried* against a 30-per-7-days allowance, so repeatedly
   * resolving new names is the one operation here that can permanently wedge the
   * pipeline.
   */
  async resolveHashtagId(name: string, signal?: AbortSignal): Promise<string> {
    const url = this.buildUrl('ig_hashtag_search', { user_id: this.igUserId, q: name });

    const { body } = await this.request(url, metaHashtagSearchResponseSchema, signal);
    const first = body.data[0];

    if (!first) {
      // A valid response with an empty array means Meta does not recognise the
      // tag - a different failure from a network or auth problem.
      throw new ApiError(404, 'HASHTAG_NOT_FOUND', `Meta returned no hashtag ID for "${name}"`);
    }

    log.info({ hashtag: name, igHashtagId: first.id }, 'resolved hashtag id');
    return first.id;
  }

  /**
   * Walks a media edge page by page, following Meta's `after` cursor.
   *
   * An async generator rather than a function returning an array, so the caller
   * can persist each page as it arrives. That matters for a 500-item sync: a
   * failure on page 9 keeps the first 8 pages of work instead of discarding
   * everything, and memory stays flat.
   *
   * Stops when Meta runs out of pages or `maxItems` is reached, whichever is
   * first. The caller can tell which by comparing the item count to the cap.
   */
  async *paginateMedia(options: PaginateOptions): AsyncGenerator<MediaPage> {
    /**
     * Mutable because Meta's real page-size ceiling is discovered, not declared.
     * It starts at the configured value and halves on each "reduce the amount of
     * data" rejection; once a size succeeds it is reused for the remaining pages
     * rather than re-probed, so the cost of negotiation is a couple of wasted
     * calls per run at most.
     */
    const requested = options.pageSize ?? env.SYNC_PAGE_SIZE;
    const learned = this.learnedPageSize.get(options.edge);

    /**
     * Start one doubling above what was last accepted, capped by the configured
     * upper bound.
     *
     * Measured behaviour: Meta's ceiling is not stable - 6 was accepted on one
     * run and rejected on the next - so this has to adapt in both directions. A
     * purely downward ratchet would decay a long-lived worker toward limit=1 and
     * leave it there permanently, turning one bad minute into indefinitely slow
     * syncs. Probing upward costs at most one wasted call per run and restores
     * throughput on its own.
     */
    let pageSize = learned ? Math.min(requested, learned * 2) : requested;
    let cursor: string | undefined;
    let pageNumber = 0;
    let yielded = 0;

    while (yielded < options.maxItems) {
      // Ask only for what is still needed, so the final page does not overshoot.
      const limit = Math.min(pageSize, options.maxItems - yielded);

      const url = this.buildUrl(`${options.hashtagId}/${options.edge}`, {
        user_id: this.igUserId,
        fields: MEDIA_FIELDS.join(','),
        limit: String(limit),
        ...(cursor ? { after: cursor } : {}),
      });

      let result: RequestResult<typeof metaMediaResponseSchema._output>;

      try {
        result = await this.request(url, metaMediaResponseSchema, options.signal);
      } catch (error) {
        if (error instanceof MetaPayloadTooLargeError && limit > 1) {
          const reduced = Math.max(1, Math.floor(limit / 2));
          log.warn(
            { edge: options.edge, rejectedLimit: limit, retryingWith: reduced },
            'Meta rejected page size, negotiating down',
          );
          pageSize = reduced;
          // Same cursor, smaller page - no items are skipped.
          continue;
        }
        throw error;
      }

      // Record the size that worked so later pages, and later syncs in this
      // process, skip the probe entirely.
      this.learnedPageSize.set(options.edge, pageSize);

      const { body, rateLimit } = result;
      pageNumber += 1;

      const items = body.data;
      yielded += items.length;

      const nextCursor = body.paging?.cursors?.after;
      // `next` present is the authoritative signal that another page exists; a
      // cursor can be returned on the final page too.
      const hasMore = Boolean(body.paging?.next) && Boolean(nextCursor);

      yield {
        items,
        pageNumber,
        nextCursor: hasMore ? nextCursor : undefined,
        rateLimit,
      };

      if (!hasMore || items.length === 0) {
        return;
      }

      cursor = nextCursor;

      // Slow down before Meta forces us to.
      const delay = throttleDelayMs(rateLimit, env.META_THROTTLE_THRESHOLD_PCT);
      if (delay > 0) {
        log.warn(
          { delayMs: delay, usagePct: rateLimit?.worstPct },
          'approaching Meta rate limit, backing off',
        );
        await sleep(delay, options.signal);
      }
    }
  }

  // -------------------------------------------------------------------------

  private buildUrl(path: string, params: Record<string, string>): URL {
    const url = new URL(`${this.baseUrl}/${path}`);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    url.searchParams.set('access_token', this.accessToken);
    return url;
  }

  /** The URL minus the token, for logs and error messages. */
  private redactUrl(url: URL): string {
    const copy = new URL(url.toString());
    copy.searchParams.set('access_token', '[redacted]');
    return copy.toString();
  }

  /**
   * Performs one request with retries.
   *
   * Retries only what is worth retrying: network failures, 5xx, and throttling.
   * An expired token (code 190) fails immediately and loudly - retrying it wastes
   * time and, worse, an auth failure that degrades into "0 items synced" is the
   * pipeline's most dangerous silent failure.
   */
  private async request<T>(
    url: URL,
    schema: { parse: (input: unknown) => T },
    signal?: AbortSignal,
    maxAttempts = 4,
  ): Promise<RequestResult<T>> {
    const safeUrl = this.redactUrl(url);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Respect throttling observed on the previous call before spending another.
      const preDelay = throttleDelayMs(this.lastRateLimit, env.META_THROTTLE_THRESHOLD_PCT);
      if (preDelay > 0) {
        await sleep(preDelay, signal);
      }

      let response: Response;

      try {
        /**
         * Both signals must apply. Using the caller's signal alone would drop the
         * timeout whenever one is supplied - so a worker shutting down gracefully
         * would also silently lose its protection against a hung connection.
         */
        const timeoutSignal = AbortSignal.timeout(env.META_REQUEST_TIMEOUT_MS);
        response = await fetch(url, {
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
          headers: { accept: 'application/json' },
        });
      } catch (error) {
        // Network-level failure: no response, always worth retrying.
        lastError = error;
        log.warn({ attempt, url: safeUrl, err: error }, 'meta request failed at network level');
        if (attempt === maxAttempts) {
          break;
        }
        await sleep(this.backoffMs(attempt), signal);
        continue;
      }

      const rateLimit = parseRateLimitHeaders(response.headers);
      if (rateLimit) {
        this.lastRateLimit = rateLimit;
      }

      const text = await response.text();
      let parsedBody: unknown;

      try {
        parsedBody = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        lastError = new ApiError(
          502,
          'META_INVALID_JSON',
          `Meta returned non-JSON (status ${response.status})`,
          { bodyPreview: text.slice(0, 200) },
        );
        if (attempt === maxAttempts) {
          break;
        }
        await sleep(this.backoffMs(attempt), signal);
        continue;
      }

      // Meta puts an `error` object in the body; it can appear even on a 200.
      const metaError = metaErrorResponseSchema.safeParse(parsedBody);

      if (metaError.success) {
        const { code, message, error_subcode: subcode } = metaError.data.error;

        if (code !== undefined && AUTH_ERROR_CODES.has(code)) {
          // Terminal. Surfacing this clearly is the whole point - see the note in
          // instructions.md about token expiry.
          throw new MetaAuthError(
            `Meta rejected the access token (code ${code}): ${message}. ` +
              `The token has likely expired or been revoked - refresh META_ACCESS_TOKEN.`,
            { code, subcode },
          );
        }

        const throttled =
          (code !== undefined && RATE_LIMIT_ERROR_CODES.has(code)) || response.status === 429;

        if (throttled) {
          lastError = new MetaRateLimitError(`Meta rate limit hit (code ${code}): ${message}`, {
            code,
            subcode,
          });
          log.warn({ attempt, code, usagePct: rateLimit?.worstPct }, 'meta rate limited');
          if (attempt === maxAttempts) {
            break;
          }
          // Throttling needs a longer pause than a transient 500.
          await sleep(Math.max(this.backoffMs(attempt) * 4, 5_000), signal);
          continue;
        }

        // Checked BEFORE the HTTP status, deliberately.
        //
        // Meta returns HTTP 500 for this error even though it is caused by our
        // request being too large, so status-based classification is actively
        // misleading: treating it as a transient server fault means blind-retrying
        // an identical request four times and then failing, instead of shrinking
        // the page. On these edges the Graph error code is the reliable signal,
        // not the status line.
        if (code === 1 && /reduce the amount of data/i.test(message)) {
          const attempted = Number(url.searchParams.get('limit') ?? 0);
          throw new MetaPayloadTooLargeError(message, attempted, { code, subcode });
        }

        if (RETRYABLE_STATUS.has(response.status)) {
          lastError = new ApiError(502, 'META_TRANSIENT_ERROR', message, { code, subcode });
          if (attempt === maxAttempts) {
            break;
          }
          await sleep(this.backoffMs(attempt), signal);
          continue;
        }

        // Everything else is our request being wrong - e.g. asking for `children`
        // on an edge that does not support it. Retrying it unchanged cannot help.
        throw new ApiError(502, 'META_REQUEST_REJECTED', `Meta rejected the request: ${message}`, {
          code,
          subcode,
          url: safeUrl,
        });
      }

      if (!response.ok) {
        lastError = new ApiError(
          502,
          'META_HTTP_ERROR',
          `Meta returned HTTP ${response.status} with no error envelope`,
          { status: response.status, bodyPreview: text.slice(0, 200) },
        );
        if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) {
          throw lastError;
        }
        await sleep(this.backoffMs(attempt), signal);
        continue;
      }

      // Shape validation happens here so a schema drift is reported at the
      // boundary, with the offending payload, rather than as a database error.
      try {
        return { body: schema.parse(parsedBody), rateLimit };
      } catch (error) {
        throw new ApiError(502, 'META_SCHEMA_MISMATCH', 'Meta response failed validation', {
          url: safeUrl,
          issues: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ApiError(502, 'META_UNAVAILABLE', `Meta request failed after ${maxAttempts} attempts`);
  }

  /** Exponential backoff with jitter, so concurrent workers do not retry in lockstep. */
  private backoffMs(attempt: number): number {
    const base = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
    return base + Math.floor(Math.random() * 500);
  }
}

/** Shared instance. Stateless apart from the rate-limit reading it carries forward. */
export const metaClient = new MetaGraphClient();
