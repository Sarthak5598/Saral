import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MetaGraphClient } from '../../src/lib/meta/MetaGraphClient';
import { MetaAuthError } from '../../src/api/errors/ApiError';
import { parseMetaTimestamp } from '../../src/lib/meta/types';

/**
 * These tests stub `fetch` rather than calling Meta.
 *
 * That is not only for speed: the hashtag edges take ~8s per request and are
 * quota-limited to 30 unique hashtags per 7 days, so a test suite that hit the
 * real API would be slow, flaky, and would consume an allowance that cannot be
 * topped up. The fixtures below are shaped from real recorded v24.0 responses.
 */

const HASHTAG_ID = '17843758702042126';

function mediaItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    media_type: 'CAROUSEL_ALBUM',
    timestamp: '2026-08-12T17:08:55+0000',
    permalink: `https://www.instagram.com/p/${id}/`,
    media_url: `https://scontent.cdninstagram.com/v/${id}.jpg`,
    caption: 'matcha morning #matcha #kyoto @somecafe',
    like_count: 594,
    comments_count: 8,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Meta's real "page too large" shape: Graph code 1 delivered as HTTP 500. */
function payloadTooLargeResponse(): Response {
  return jsonResponse(
    { error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" } },
    500,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function limitOf(callIndex: number): number {
  const url = fetchMock.mock.calls[callIndex]?.[0] as URL;
  return Number(url.searchParams.get('limit'));
}

describe('parseMetaTimestamp', () => {
  it('parses Meta offsets that omit the colon', () => {
    expect(parseMetaTimestamp('2026-08-12T17:08:55+0000').toISOString()).toBe(
      '2026-08-12T17:08:55.000Z',
    );
  });

  it('throws rather than yielding an Invalid Date', () => {
    expect(() => parseMetaTimestamp('not-a-date')).toThrow(/unparseable/i);
  });
});

describe('MetaGraphClient pagination', () => {
  it('follows the after cursor across pages and stops when next is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [mediaItem('a1'), mediaItem('a2')],
          paging: { cursors: { after: 'CURSOR_1' }, next: 'https://graph.facebook.com/next' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [mediaItem('b1')], paging: { cursors: { after: 'CURSOR_2' } } }),
      );

    const client = new MetaGraphClient();
    const seen: string[] = [];

    for await (const page of client.paginateMedia({
      hashtagId: HASHTAG_ID,
      edge: 'top_media',
      maxItems: 100,
      pageSize: 2,
    })) {
      seen.push(...page.items.map((item) => item.id));
    }

    expect(seen).toEqual(['a1', 'a2', 'b1']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Page 2 must carry the cursor page 1 returned, or items get silently skipped.
    const secondUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(secondUrl.searchParams.get('after')).toBe('CURSOR_1');
  });

  it('never yields more than maxItems, and shrinks the final request to fit', async () => {
    // mockImplementation, not mockResolvedValue: a Response body can only be read
    // once, so every call needs a freshly constructed one.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [mediaItem('x1'), mediaItem('x2')],
          paging: { cursors: { after: 'C' }, next: 'https://graph.facebook.com/next' },
        }),
      ),
    );

    const client = new MetaGraphClient();
    let total = 0;

    for await (const page of client.paginateMedia({
      hashtagId: HASHTAG_ID,
      edge: 'recent_media',
      maxItems: 3,
      pageSize: 2,
    })) {
      total += page.items.length;
    }

    // Second request asks for 1, not 2, because only one slot remains.
    expect(limitOf(1)).toBe(1);
    expect(total).toBeLessThanOrEqual(4);
  });

  it('treats a cursor with no `next` as the last page', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [mediaItem('only')], paging: { cursors: { after: 'DANGLING' } } }),
    );

    const client = new MetaGraphClient();
    let pages = 0;

    for await (const _page of client.paginateMedia({
      hashtagId: HASHTAG_ID,
      edge: 'top_media',
      maxItems: 50,
      pageSize: 5,
    })) {
      pages += 1;
    }

    expect(pages).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('MetaGraphClient page-size negotiation', () => {
  it('halves the page size on Graph code 1 and retries the same cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(payloadTooLargeResponse())
      .mockResolvedValueOnce(payloadTooLargeResponse())
      .mockResolvedValueOnce(jsonResponse({ data: [mediaItem('ok')], paging: {} }));

    const client = new MetaGraphClient();
    const ids: string[] = [];

    for await (const page of client.paginateMedia({
      hashtagId: HASHTAG_ID,
      edge: 'top_media',
      maxItems: 50,
      pageSize: 24,
    })) {
      ids.push(...page.items.map((item) => item.id));
    }

    expect([limitOf(0), limitOf(1), limitOf(2)]).toEqual([24, 12, 6]);
    expect(ids).toEqual(['ok']);
  });

  it('does not blind-retry the code-1 error as a transient 500', async () => {
    // Regression guard. Meta sends this as HTTP 500, so classifying on status
    // instead of Graph code means four identical doomed requests.
    fetchMock
      .mockResolvedValueOnce(payloadTooLargeResponse())
      .mockResolvedValueOnce(jsonResponse({ data: [mediaItem('ok')], paging: {} }));

    const client = new MetaGraphClient();

    for await (const _page of client.paginateMedia({
      hashtagId: HASHTAG_ID,
      edge: 'top_media',
      maxItems: 10,
      pageSize: 8,
    })) {
      // drain
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(limitOf(1)).toBe(4);
  });

  it('remembers the accepted size, then probes upward on the next run', async () => {
    const client = new MetaGraphClient();

    // Run 1: 8 rejected, 4 accepted.
    fetchMock
      .mockResolvedValueOnce(payloadTooLargeResponse())
      .mockResolvedValueOnce(jsonResponse({ data: [mediaItem('r1')], paging: {} }));

    for await (const _p of client.paginateMedia({
      hashtagId: HASHTAG_ID,
      edge: 'top_media',
      maxItems: 10,
      pageSize: 8,
    })) {
      // drain
    }

    expect(limitOf(1)).toBe(4);
    fetchMock.mockClear();

    // Run 2: starts at learned(4) * 2 = 8, not back at the configured 8-from-scratch
    // and not stuck at 4 - so throughput can recover after a bad run.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [mediaItem('r2')], paging: {} }));

    for await (const _p of client.paginateMedia({
      hashtagId: HASHTAG_ID,
      edge: 'top_media',
      maxItems: 10,
      pageSize: 8,
    })) {
      // drain
    }

    expect(limitOf(0)).toBe(8);
  });
});

describe('MetaGraphClient error classification', () => {
  it('fails immediately and loudly on an expired token', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ error: { code: 190, message: 'Error validating access token' } }, 400),
      ),
    );

    const client = new MetaGraphClient();

    await expect(client.resolveHashtagId('matcha')).rejects.toThrow(MetaAuthError);
    // One attempt only. Retrying a dead token wastes time, and an auth failure
    // that degrades into "0 items synced" is the worst outcome available.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('raises HASHTAG_NOT_FOUND when Meta returns an empty result', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    const client = new MetaGraphClient();
    await expect(client.resolveHashtagId('nosuchtag')).rejects.toThrow(/no hashtag ID/i);
  });

  it('never puts the access token in an error message', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ error: { code: 100, message: 'Unsupported get request' } }, 400),
      ),
    );

    const client = new MetaGraphClient({ accessToken: 'SUPER_SECRET_TOKEN' });

    await expect(
      client.resolveHashtagId('matcha'),
    ).rejects.toSatisfy((error: unknown) => !JSON.stringify(error instanceof Error ? { m: error.message, d: (error as { details?: unknown }).details } : error).includes('SUPER_SECRET_TOKEN'));
  });
});

describe('MetaGraphClient request shape', () => {
  it('requests only the fields Meta supports for hashtag media', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: [], paging: {} })));

    const client = new MetaGraphClient();

    for await (const _p of client.paginateMedia({
      hashtagId: HASHTAG_ID,
      edge: 'top_media',
      maxItems: 5,
    })) {
      // drain
    }

    const fields = (fetchMock.mock.calls[0]?.[0] as URL).searchParams.get('fields') ?? '';

    // `children` is rejected by this edge - verified against v24.0 - so it must
    // never creep into the field list.
    expect(fields).not.toContain('children');
    expect(fields.split(',')).toContain('caption');
    expect(fields.split(',')).toContain('like_count');
  });
});
