import { BadRequestError } from '../../errors/ApiError';

/**
 * Keyset pagination cursor, encoding the sort key of the last returned row.
 *
 * Keyset rather than OFFSET, because this table is continuously written to. With
 * OFFSET, a sync inserting rows between two requests shifts everything down and the
 * client sees an item twice or skips one entirely - and this pipeline inserts on
 * every 3-hour run, so that is the normal case rather than a rare race.
 *
 * The sort key is (taken_at, id): taken_at alone is not unique - Instagram posts
 * share timestamps - so without the id tiebreak the ordering is not total and a
 * cursor cannot reliably resume.
 *
 * Base64url-encoded to signal "opaque, do not construct these yourself", not for
 * secrecy. It is trivially decodable and is validated on the way back in.
 */

interface CursorPayload {
  takenAt: string;
  id: string;
}

export function encodeCursor(takenAt: Date, id: string): string {
  const payload: CursorPayload = { takenAt: takenAt.toISOString(), id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): { takenAt: Date; id: string } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('cursor is not valid base64url-encoded JSON');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as CursorPayload).takenAt !== 'string' ||
    typeof (parsed as CursorPayload).id !== 'string'
  ) {
    throw new BadRequestError('cursor is missing takenAt or id');
  }

  const payload = parsed as CursorPayload;
  const takenAt = new Date(payload.takenAt);

  if (Number.isNaN(takenAt.getTime())) {
    throw new BadRequestError('cursor contains an invalid takenAt timestamp');
  }

  // Guards the SQL comparison: an arbitrary string here would be compared against
  // a uuid column and error at the database rather than the boundary.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id)) {
    throw new BadRequestError('cursor contains an invalid id');
  }

  return { takenAt, id: payload.id };
}
