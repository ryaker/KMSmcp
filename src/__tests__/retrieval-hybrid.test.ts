/**
 * Unit tests for the pure fusion primitives in src/retrieval/hybrid.ts.
 *
 * These pin the properties the fusion is *chosen* for, not just that it runs:
 *   - membership in a ranked list is decided by provenance, not by score
 *   - the two arms' incomparable magnitudes never enter the fused score
 *   - recency can break a tie and can never outrank RRF
 *   - the result is deterministic, so an offline replay matches the live run
 */

import {
  RRF_K,
  RRF_WEIGHT_LEXICAL,
  RRF_WEIGHT_VECTOR,
  fuseWithRRF,
  isHybridRetrievalEnabled,
  isLexicalCandidate,
  isVectorCandidate,
  candidateSourceSystems,
} from '../retrieval/hybrid.js'

describe('isHybridRetrievalEnabled', () => {
  it('is off when the flag is unset', () => {
    expect(isHybridRetrievalEnabled({})).toBe(false)
  })

  it('is on only for the exact string "1"', () => {
    expect(isHybridRetrievalEnabled({ KMS_HYBRID_RETRIEVAL: '1' })).toBe(true)
    expect(isHybridRetrievalEnabled({ KMS_HYBRID_RETRIEVAL: '0' })).toBe(false)
    // "true"/"yes" are NOT accepted: an operator disabling the feature must never be
    // able to enable it by accident with a truthy-looking string.
    expect(isHybridRetrievalEnabled({ KMS_HYBRID_RETRIEVAL: 'true' })).toBe(false)
    expect(isHybridRetrievalEnabled({ KMS_HYBRID_RETRIEVAL: '' })).toBe(false)
  })
})

describe('arm membership', () => {
  it('uses provenance, not score, to decide lexical membership', () => {
    // Relevance 0 but retrieved by mem0 → still a member of the lexical list.
    expect(isLexicalCandidate({ sourceSystem: 'mem0', _lexicalScore: 0 })).toBe(true)
    // Retrieved only by the vector arm → NOT a member, whatever its lexical score.
    expect(isLexicalCandidate({ sourceSystem: 'vector', _lexicalScore: 0.9 })).toBe(false)
  })

  it('reads the merged _sourceSystems list when dedup produced one', () => {
    expect(candidateSourceSystems({ _sourceSystems: ['vector', 'mongodb'] }))
      .toEqual(['vector', 'mongodb'])
    expect(isLexicalCandidate({ sourceSystem: 'vector', _sourceSystems: ['vector', 'mongodb'] })).toBe(true)
  })

  it('requires a finite similarity for vector membership', () => {
    expect(isVectorCandidate({ _vectorSimilarity: 0 })).toBe(true)
    expect(isVectorCandidate({})).toBe(false)
    expect(isVectorCandidate({ _vectorSimilarity: NaN })).toBe(false)
  })
})

describe('fuseWithRRF', () => {
  it('uses k=60 and equal per-arm weights', () => {
    expect(RRF_K).toBe(60)
    expect(RRF_WEIGHT_LEXICAL).toBe(1)
    expect(RRF_WEIGHT_VECTOR).toBe(1)
  })

  it('scores each candidate as the sum of 1/(k+rank) over the arms that retrieved it', () => {
    const fused = fuseWithRRF([
      { id: 'both', sourceSystem: 'mem0', _sourceSystems: ['mem0', 'vector'], _lexicalScore: 0.9, _vectorSimilarity: 0.8 },
      { id: 'lex', sourceSystem: 'mem0', _lexicalScore: 0.5 },
      { id: 'vec', sourceSystem: 'vector', _vectorSimilarity: 0.4 },
    ])
    const byId = Object.fromEntries(fused.map(c => [c.id, c]))

    expect(byId.both._lexicalRank).toBe(1)
    expect(byId.both._vectorRank).toBe(1)
    expect(byId.both._rrf).toBeCloseTo(1 / 61 + 1 / 61, 6)

    expect(byId.lex._lexicalRank).toBe(2)
    expect(byId.lex._vectorRank).toBeUndefined()
    expect(byId.lex._rrf).toBeCloseTo(1 / 62, 6)

    expect(byId.vec._lexicalRank).toBeUndefined()
    expect(byId.vec._vectorRank).toBe(2)
    expect(byId.vec._rrf).toBeCloseTo(1 / 62, 6)

    // Agreement between the arms wins.
    expect(fused[0].id).toBe('both')
  })

  it('is scale-free: multiplying one arm\'s scores changes nothing', () => {
    const base = [
      { id: 'a', sourceSystem: 'mem0', _lexicalScore: 0.9 },
      { id: 'b', sourceSystem: 'vector', _vectorSimilarity: 0.81 },
      { id: 'c', sourceSystem: 'vector', _vectorSimilarity: 0.79 },
    ]
    // Cosine similarities on this corpus live in a narrow high band; a weighted sum
    // would be extremely sensitive to that. Rank fusion is not.
    const squashed = base.map(c =>
      c._vectorSimilarity !== undefined ? { ...c, _vectorSimilarity: c._vectorSimilarity / 1000 } : c
    )
    expect(fuseWithRRF(base).map(c => c.id)).toEqual(fuseWithRRF(squashed).map(c => c.id))
  })

  it('breaks an exact RRF tie by recency, and only a tie', () => {
    // Both are their own arm's #1 → identical RRF of 1/61.
    const fused = fuseWithRRF([
      { id: 'stale-vector', sourceSystem: 'vector', _vectorSimilarity: 0.95, _recency: 0.1 },
      { id: 'fresh-lexical', sourceSystem: 'mem0', _lexicalScore: 0.3, _recency: 0.99 },
    ])
    expect(fused.map(c => c.id)).toEqual(['fresh-lexical', 'stale-vector'])
    expect(fused[0]._rrf).toBe(fused[1]._rrf)
  })

  it('never lets recency overturn a genuine RRF difference', () => {
    // The stale candidate is #1 in the vector arm; the fresh one is #2 in the lexical
    // arm. Recency is maximal for the loser and near-zero for the winner, and it still
    // does not move. Under the shipped lexical composite (recency at 0.25 of the score)
    // the fresh entry would win — which is the measured meta-noise failure mode.
    const fused = fuseWithRRF([
      { id: 'fresh-but-second', sourceSystem: 'mem0', _lexicalScore: 0.2, _recency: 1 },
      { id: 'stale-but-first', sourceSystem: 'mem0', _lexicalScore: 0.9, _recency: 0.001 },
    ])
    expect(fused.map(c => c.id)).toEqual(['stale-but-first', 'fresh-but-second'])
  })

  it('does not mutate its input', () => {
    const input = [{ id: 'a', sourceSystem: 'mem0', _lexicalScore: 0.5 }]
    fuseWithRRF(input)
    expect(input[0]).not.toHaveProperty('_rrf')
    expect(input[0]).not.toHaveProperty('_lexicalRank')
  })

  it('falls back to id order when RRF, recency and lexical score are all equal', () => {
    // Two arm-leaders that agree on every tie-break: without a final deterministic
    // guard their order would depend on input order, and an offline replay of the
    // captured pool could disagree with the live run it is supposed to reproduce.
    const tied = [
      { id: 'zeta', sourceSystem: 'vector', _vectorSimilarity: 0.9, _recency: 0.5, _lexicalScore: 0 },
      { id: 'alpha', sourceSystem: 'mem0', _lexicalScore: 0, _recency: 0.5 },
    ]
    expect(fuseWithRRF(tied).map(c => c.id)).toEqual(['alpha', 'zeta'])
    expect(fuseWithRRF([...tied].reverse()).map(c => c.id)).toEqual(['alpha', 'zeta'])
  })

  it('returns an empty list unchanged', () => {
    expect(fuseWithRRF([])).toEqual([])
  })
})
