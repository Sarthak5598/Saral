import { describe, expect, it } from 'vitest';

import {
  parseCaptionArrays,
  parseCaptionEntities,
} from '../../src/api/services/captionParser';

function hashtags(caption: string): string[] {
  return parseCaptionEntities(caption)
    .filter((entity) => entity.type === 'hashtag')
    .map((entity) => entity.value);
}

function mentions(caption: string): string[] {
  return parseCaptionEntities(caption)
    .filter((entity) => entity.type === 'mention')
    .map((entity) => entity.value);
}

describe('parseCaptionEntities', () => {
  it('returns nothing for empty or missing captions', () => {
    expect(parseCaptionEntities(null)).toEqual([]);
    expect(parseCaptionEntities(undefined)).toEqual([]);
    expect(parseCaptionEntities('')).toEqual([]);
    expect(parseCaptionEntities('no tags at all here')).toEqual([]);
  });

  it('extracts hashtags and mentions, lowercased', () => {
    const caption = 'Morning ritual #Matcha #MatchaLatte at @SomeCafe_London';

    expect(hashtags(caption)).toEqual(['matcha', 'matchalatte']);
    expect(mentions(caption)).toEqual(['somecafe_london']);
  });

  it('deduplicates repeated tags', () => {
    // Captions repeat tags constantly, and the table has a UNIQUE(media, type,
    // value) constraint - so deduplication has to happen before insert.
    expect(hashtags('#matcha #matcha #MATCHA #Matcha')).toEqual(['matcha']);
  });

  it('keeps whole hashtags in scripts that use combining marks', () => {
    // Regression test for a bug found on real matcha data. Thai and Arabic build
    // characters from a base letter plus combining marks (\p{M}); a pattern of
    // only [\p{L}\p{N}_] truncated these to a single character.
    expect(hashtags('#มัทฉะ')).toEqual(['มัทฉะ']);
    expect(hashtags('#ماتشا')).toEqual(['ماتشا']);
    expect(hashtags('#抹茶 #マッチャ')).toEqual(['抹茶', 'マッチャ']);
    expect(hashtags('#Matchá #café')).toEqual(['matchá', 'café']);
  });

  it('ignores digit-only hashtags', () => {
    // "#2026" and "#1" are years and list numbering; they pollute co-occurrence
    // rankings without carrying topical meaning.
    expect(hashtags('#2026 #1 #matcha')).toEqual(['matcha']);
  });

  it('strips trailing periods from mentions but keeps internal ones', () => {
    expect(mentions('thanks @some.cafe. lovely')).toEqual(['some.cafe']);
  });

  it('handles hashtags adjacent to punctuation and newlines', () => {
    const caption = '#matcha,\n#kyoto!\n(#wagashi)';
    expect(hashtags(caption)).toEqual(['matcha', 'kyoto', 'wagashi']);
  });

  it('caps values at the column width', () => {
    const long = 'a'.repeat(400);
    const [entity] = parseCaptionEntities(`#${long}`);
    expect(entity?.value.length).toBe(255);
  });

  it('treats an email-like string as a mention of the local part boundary', () => {
    // Not ideal, but documented: Instagram captions rarely contain emails, and
    // over-engineering the parser to exclude them risks dropping real mentions.
    expect(mentions('reach me at hi@somecafe')).toEqual(['somecafe']);
  });
});

describe('parseCaptionArrays', () => {
  it('splits into the two array columns stored on media_posts', () => {
    const result = parseCaptionArrays('#Matcha at @SomeCafe with #Kyoto vibes');

    expect(result.hashtags).toEqual(['matcha', 'kyoto']);
    expect(result.mentions).toEqual(['somecafe']);
  });

  it('returns empty arrays rather than null for a missing caption', () => {
    // The columns are nullable in Postgres, but the parser should never be what
    // introduces a null - callers store [] and the API returns [].
    expect(parseCaptionArrays(null)).toEqual({ hashtags: [], mentions: [] });
    expect(parseCaptionArrays('plain text')).toEqual({ hashtags: [], mentions: [] });
  });

  it('holds a full 30-hashtag caption without truncating', () => {
    // 30 is Instagram's per-post ceiling, which is what makes an array column a
    // reasonable choice here rather than a join table.
    const caption = Array.from({ length: 30 }, (_, i) => `#tag${i}`).join(' ');
    expect(parseCaptionArrays(caption).hashtags).toHaveLength(30);
  });
});
