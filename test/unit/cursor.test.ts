import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../../src/api/controllers/responses/cursor';
import { listHashtagMediaQuerySchema } from '../../src/api/controllers/requests/listHashtagMediaRequest';
import { BadRequestError } from '../../src/api/errors/ApiError';

const ID = '949d67c3-b749-48b2-bfc4-31ae82ef2d14';

describe('keyset cursor', () => {
  it('round-trips a timestamp and id', () => {
    const takenAt = new Date('2026-08-12T17:08:55.000Z');
    const decoded = decodeCursor(encodeCursor(takenAt, ID));

    expect(decoded.takenAt.toISOString()).toBe(takenAt.toISOString());
    expect(decoded.id).toBe(ID);
  });

  it('produces a URL-safe token', () => {
    const cursor = encodeCursor(new Date('2026-08-12T17:08:55.000Z'), ID);

    // base64url, so it survives a query string without escaping.
    expect(cursor).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('rejects malformed input with 400, not 500', () => {
    // These reach the database as a uuid comparison if unvalidated, which would
    // surface as an opaque server error instead of a client error.
    expect(() => decodeCursor('not-base64-json')).toThrow(BadRequestError);
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(BadRequestError);
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ takenAt: 'nope', id: ID })).toString('base64url')),
    ).toThrow(/invalid takenAt/);
    expect(() =>
      decodeCursor(
        Buffer.from(JSON.stringify({ takenAt: new Date().toISOString(), id: 'x' })).toString(
          'base64url',
        ),
      ),
    ).toThrow(/invalid id/);
  });

  it('rejects a SQL-injection attempt in the id field', () => {
    const hostile = Buffer.from(
      JSON.stringify({ takenAt: new Date().toISOString(), id: "' OR 1=1 --" }),
    ).toString('base64url');

    expect(() => decodeCursor(hostile)).toThrow(BadRequestError);
  });
});

describe('GET /hashtags query validation', () => {
  it('applies defaults', () => {
    const parsed = listHashtagMediaQuerySchema.parse({});

    expect(parsed.limit).toBe(25);
    expect(parsed.includeStale).toBe(true);
    expect(parsed.includeAsset).toBe(true);
    expect(parsed.hashtag).toBeUndefined();
  });

  it('coerces numeric strings from the query string', () => {
    expect(listHashtagMediaQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps limit so a client cannot request the whole table', () => {
    expect(() => listHashtagMediaQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => listHashtagMediaQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => listHashtagMediaQuerySchema.parse({ limit: 'abc' })).toThrow();
  });

  it('rejects an unknown mediaType', () => {
    expect(() => listHashtagMediaQuerySchema.parse({ mediaType: 'GIF' })).toThrow();
    expect(listHashtagMediaQuerySchema.parse({ mediaType: 'VIDEO' }).mediaType).toBe('VIDEO');
  });

  it('parses date filters', () => {
    const parsed = listHashtagMediaQuerySchema.parse({ takenAfter: '2026-08-01' });
    expect(parsed.takenAfter?.getUTCFullYear()).toBe(2026);
  });

  it('turns the includeStale string into a boolean', () => {
    expect(listHashtagMediaQuerySchema.parse({ includeStale: 'false' }).includeStale).toBe(false);
    expect(listHashtagMediaQuerySchema.parse({ includeStale: 'true' }).includeStale).toBe(true);
  });
});
