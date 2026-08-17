/**
 * Meta reports rate-limit consumption in response headers rather than only via
 * 429s. Reading them lets the pipeline slow down *before* being throttled, which
 * matters here because the hashtag edges are quota-constrained in a way that
 * cannot be worked around: 30 unique hashtags per rolling 7 days, per IG account.
 *
 * Two headers carry it:
 *   X-App-Usage                 {"call_count":12,"total_cputime":3,"total_time":5}
 *   X-Business-Use-Case-Usage   {"<id>":[{"call_count":8,...,
 *                                "estimated_time_to_regain_access":0}]}
 *
 * All figures are percentages of the allowance, 0-100.
 */

export interface RateLimitUsage {
  /** Highest percentage across every reported dimension. */
  worstPct: number;
  callCountPct?: number;
  cpuTimePct?: number;
  totalTimePct?: number;
  /** Minutes Meta says to wait before retrying. Non-zero means already blocked. */
  estimatedTimeToRegainAccessMinutes?: number;
  raw: Record<string, unknown>;
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    // A malformed usage header must never break an otherwise successful request.
    return undefined;
  }
}

function pctOf(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Extracts usage from response headers. Returns undefined when neither header is
 * present - notably on the ig_hashtag_search endpoint, which does not always
 * report usage.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitUsage | undefined {
  const appUsage = safeJsonParse(headers.get('x-app-usage'));
  const bucUsage = safeJsonParse(headers.get('x-business-use-case-usage'));

  const candidates: Array<Record<string, unknown>> = [];

  if (appUsage && typeof appUsage === 'object') {
    candidates.push(appUsage as Record<string, unknown>);
  }

  // Business-use-case usage is keyed by business/IG account ID, each holding an
  // array of per-use-case entries. Flatten them all and take the worst.
  if (bucUsage && typeof bucUsage === 'object') {
    for (const entries of Object.values(bucUsage as Record<string, unknown>)) {
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry && typeof entry === 'object') {
            candidates.push(entry as Record<string, unknown>);
          }
        }
      }
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  let worstPct = 0;
  let callCountPct: number | undefined;
  let cpuTimePct: number | undefined;
  let totalTimePct: number | undefined;
  let regainMinutes: number | undefined;

  for (const candidate of candidates) {
    const call = pctOf(candidate, 'call_count');
    const cpu = pctOf(candidate, 'total_cputime');
    const total = pctOf(candidate, 'total_time');
    const regain = pctOf(candidate, 'estimated_time_to_regain_access');

    callCountPct = Math.max(callCountPct ?? 0, call ?? 0) || callCountPct || call;
    cpuTimePct = Math.max(cpuTimePct ?? 0, cpu ?? 0) || cpuTimePct || cpu;
    totalTimePct = Math.max(totalTimePct ?? 0, total ?? 0) || totalTimePct || total;

    if (regain !== undefined && regain > 0) {
      regainMinutes = Math.max(regainMinutes ?? 0, regain);
    }

    worstPct = Math.max(worstPct, call ?? 0, cpu ?? 0, total ?? 0);
  }

  return {
    worstPct,
    callCountPct,
    cpuTimePct,
    totalTimePct,
    estimatedTimeToRegainAccessMinutes: regainMinutes,
    raw: { appUsage, bucUsage } as Record<string, unknown>,
  };
}

/**
 * How long to pause before the next request given current usage.
 *
 * Deliberately coarse: below the threshold, do not wait at all; above it, back
 * off proportionally to how far over we are. The goal is avoiding a hard block,
 * not squeezing out maximum throughput.
 */
export function throttleDelayMs(usage: RateLimitUsage | undefined, thresholdPct: number): number {
  if (!usage) {
    return 0;
  }

  // Already blocked - respect Meta's own estimate, capped so a bad value cannot
  // wedge the worker for hours.
  if (usage.estimatedTimeToRegainAccessMinutes && usage.estimatedTimeToRegainAccessMinutes > 0) {
    return Math.min(usage.estimatedTimeToRegainAccessMinutes * 60_000, 5 * 60_000);
  }

  if (usage.worstPct < thresholdPct) {
    return 0;
  }

  // Ramp from 1s at the threshold to 30s at 100%.
  const over = (usage.worstPct - thresholdPct) / Math.max(100 - thresholdPct, 1);
  return Math.round(1_000 + over * 29_000);
}
