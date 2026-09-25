/**
 * Unit tests for the compound-token expansion module (`src/search/compoundTokens.ts`).
 *
 * Covers the three motivating identifier shapes — camelCase/PascalCase, snake_case,
 * kebab-case/dotted.names — plus letter/digit boundaries, and the derived helpers each
 * lexical arm (UnifiedSearchTool, SparrowDBStorage, MongoDBStorage) actually calls.
 */

import {
  expandCompoundToken,
  keywordRegexSources,
  compoundSequencePattern,
  isCompoundToken,
  textIncludesTermOrParts,
} from '../search/compoundTokens.js'

describe('expandCompoundToken', () => {
  it('keeps a plain word as just itself', () => {
    expect(expandCompoundToken('timeout')).toEqual(['timeout'])
  })

  it('splits camelCase', () => {
    expect(expandCompoundToken('mem0ParentId')).toEqual(
      expect.arrayContaining(['mem0parentid', 'mem', '0', 'parent', 'id']),
    )
  })

  it('splits PascalCase', () => {
    const parts = expandCompoundToken('ParentGraphNode')
    expect(parts).toEqual(
      expect.arrayContaining(['parentgraphnode', 'parent', 'graph', 'node']),
    )
  })

  it('splits an acronym run followed by a capitalized word', () => {
    expect(expandCompoundToken('HTTPServer')).toEqual(
      expect.arrayContaining(['httpserver', 'http', 'server']),
    )
  })

  it('splits snake_case', () => {
    expect(expandCompoundToken('dedup_unchecked')).toEqual(
      expect.arrayContaining(['dedup_unchecked', 'dedup', 'unchecked']),
    )
  })

  it('splits kebab-case', () => {
    expect(expandCompoundToken('kms-context-inject')).toEqual(
      expect.arrayContaining([
        'kms-context-inject',
        'kms',
        'context',
        'inject',
      ]),
    )
  })

  it('splits dotted.names', () => {
    expect(expandCompoundToken('reference.mem0_v3_update_quirks')).toEqual(
      expect.arrayContaining([
        'reference',
        'mem0',
        'mem',
        '0',
        'v3',
        'v',
        '3',
        'update',
        'quirks',
      ]),
    )
  })

  it('splits letter/digit boundaries', () => {
    expect(expandCompoundToken('v3')).toEqual(
      expect.arrayContaining(['v3', 'v', '3']),
    )
  })

  it('lowercases every part and deduplicates', () => {
    const parts = expandCompoundToken('FooFoo')
    expect(parts.filter((p) => p === 'foo')).toHaveLength(1)
  })

  it('keeps the original token first', () => {
    expect(expandCompoundToken('mem0ParentId')[0]).toBe('mem0parentid')
  })

  it('returns [] for an empty token', () => {
    expect(expandCompoundToken('')).toEqual([])
  })
})

describe('isCompoundToken', () => {
  it('is false for a plain word', () => {
    expect(isCompoundToken('timeout')).toBe(false)
  })

  it('is true for camelCase, snake_case, kebab-case and digit-suffixed tokens', () => {
    expect(isCompoundToken('mem0ParentId')).toBe(true)
    expect(isCompoundToken('dedup_unchecked')).toBe(true)
    expect(isCompoundToken('kms-context-inject')).toBe(true)
    expect(isCompoundToken('v3')).toBe(true)
  })
})

describe('textIncludesTermOrParts', () => {
  it('matches a plain substring as before', () => {
    expect(textIncludesTermOrParts('the request timed out', 'timed')).toBe(true)
    expect(textIncludesTermOrParts('the request timed out', 'abort')).toBe(
      false,
    )
  })

  it('matches a compound query term (original case) against naturally-written content', () => {
    // The term must be passed in its original case — "mem0ParentId", not
    // "mem0parentid" — so the camelCase boundary between "Parent" and "Id" survives
    // long enough for expandCompoundToken to see it.
    expect(
      textIncludesTermOrParts('the mem0 parent id field', 'mem0ParentId'),
    ).toBe(true)
  })

  it('never matches on a single part alone', () => {
    expect(
      textIncludesTermOrParts('the field named parent exists', 'mem0ParentId'),
    ).toBe(false)
    expect(
      textIncludesTermOrParts('done in one continuous stretch', 'OneCLI'),
    ).toBe(false)
    expect(textIncludesTermOrParts('stored in memory', 'mem0')).toBe(false)
  })

  it('matches the parts in sequence across separators', () => {
    expect(textIncludesTermOrParts('use the one cli gateway', 'OneCLI')).toBe(
      true,
    )
    expect(
      textIncludesTermOrParts('flag dedup-unchecked set', 'dedup_unchecked'),
    ).toBe(true)
    expect(textIncludesTermOrParts('see mem0_parent_id', 'mem0ParentId')).toBe(
      true,
    )
  })

  it('is case-insensitive on the term side for the plain (non-expanded) match', () => {
    // `textLower` is the caller's pre-lowercased content, per every call site; `term`
    // is compared case-insensitively regardless of the case it's passed in.
    expect(textIncludesTermOrParts('the request timed out', 'TIMED')).toBe(true)
  })

  it('does not match an unrelated compound term', () => {
    expect(
      textIncludesTermOrParts(
        'completely unrelated content here',
        'mem0ParentId',
      ),
    ).toBe(false)
  })
})

describe('compoundSequencePattern', () => {
  it('is null for a plain term', () => {
    expect(compoundSequencePattern('timeout')).toBeNull()
  })

  it('joins the ordered parts with optional separators', () => {
    const re = new RegExp(compoundSequencePattern('mem0ParentId')!, 'i')
    expect(re.test('mem0ParentId')).toBe(true)
    expect(re.test('mem0 parent id')).toBe(true)
    expect(re.test('parent id mem0')).toBe(false)
  })
})

describe('keywordRegexSources', () => {
  it('escapes plain keywords', () => {
    expect(keywordRegexSources(['timeout', 'a.b+'], 40)).toEqual(
      expect.arrayContaining(['timeout', 'a\\.b\\+']),
    )
  })

  it('adds a sequence pattern for compound keywords, never bare parts', () => {
    const out = keywordRegexSources(['mem0ParentId'], 40)
    expect(out[0]).toBe('mem0parentid')
    expect(out).toContain(compoundSequencePattern('mem0ParentId'))
    expect(out).not.toContain('parent')
    expect(out).not.toContain('mem')
  })

  it('keeps originals first and caps the total', () => {
    expect(keywordRegexSources(['mem0ParentId', 'dedup_unchecked'], 2)).toEqual(
      ['mem0parentid', 'dedup_unchecked'],
    )
    const many = Array.from({ length: 10 }, (_, i) => `kms-context-inject-${i}`)
    expect(keywordRegexSources(many, 5).length).toBe(5)
  })
})
