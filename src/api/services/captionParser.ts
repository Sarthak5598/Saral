/**
 * Extracts hashtags and @mentions from a caption.
 *
 * This is the only enrichment available. Meta returns no owner, no follower data
 * and no location for hashtag media, so the caption text is the sole remaining
 * signal - and it is a useful one:
 *
 *   "what else do people tag alongside #matcha?"  -> co-occurrence over hashtags
 *   "which accounts get tagged in matcha posts?"  -> aggregate over mentions
 *
 * The results are derived, not authoritative. A caption containing "#kyoto" is a
 * soft geographic hint, never a location field.
 */

export interface CaptionEntity {
  type: 'hashtag' | 'mention';
  value: string;
}

/**
 * Unicode-aware: #抹茶 and #Matchá are real and common on this tag, so matching
 * only [a-z0-9_] would silently drop a chunk of a global hashtag's data.
 *
 * \p{M} - combining marks - is not optional here, and its absence was caught on
 * real data. Thai, Arabic and Devanagari build characters from a base letter plus
 * combining vowel marks, so `#มัทฉะ` matched only the leading `ม` before the first
 * mark terminated the match. Without \p{M} the parser silently truncates every
 * hashtag in those scripts to one character, which on a global tag like #matcha
 * is a meaningful slice of the data quietly turned into garbage.
 */
const HASHTAG_PATTERN = /#([\p{L}\p{N}\p{M}_]+)/gu;

/**
 * Instagram handles allow letters, digits, periods and underscores, up to 30
 * characters. A trailing period is legal inside a handle but is far more often
 * sentence punctuation, so it is trimmed.
 */
const MENTION_PATTERN = /@([A-Za-z0-9._]{1,30})/g;

/** Matches the varchar(255) column, guarding against pathological captions. */
const MAX_VALUE_LENGTH = 255;

function normalize(raw: string): string {
  return raw.toLowerCase().slice(0, MAX_VALUE_LENGTH);
}

/**
 * The same extraction, shaped for the two array columns on media_posts.
 *
 * Kept as a separate function rather than replacing parseCaptionEntities because the
 * flat entity list is the natural unit to test against, while the arrays are what the
 * schema stores.
 */
export function parseCaptionArrays(caption: string | null | undefined): {
  hashtags: string[];
  mentions: string[];
} {
  const entities = parseCaptionEntities(caption);

  return {
    hashtags: entities.filter((e) => e.type === 'hashtag').map((e) => e.value),
    mentions: entities.filter((e) => e.type === 'mention').map((e) => e.value),
  };
}

export function parseCaptionEntities(caption: string | null | undefined): CaptionEntity[] {
  if (!caption) {
    return [];
  }

  // A Set keyed on type+value: captions repeat tags constantly, and the table has
  // a UNIQUE(media, type, value) constraint. Deduplicating here also makes
  // re-parsing during replay naturally idempotent.
  const seen = new Set<string>();
  const entities: CaptionEntity[] = [];

  for (const match of caption.matchAll(HASHTAG_PATTERN)) {
    const captured = match[1];
    if (!captured) {
      continue;
    }

    const value = normalize(captured);
    // Reject digit-only tags: "#1" and "#2026" are almost always numbering or a
    // year, and they pollute co-occurrence rankings.
    if (!value || /^\d+$/.test(value)) {
      continue;
    }

    const key = `hashtag:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ type: 'hashtag', value });
    }
  }

  for (const match of caption.matchAll(MENTION_PATTERN)) {
    const captured = match[1];
    if (!captured) {
      continue;
    }

    const value = normalize(captured.replace(/\.+$/, ''));
    if (!value) {
      continue;
    }

    const key = `mention:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ type: 'mention', value });
    }
  }

  return entities;
}
