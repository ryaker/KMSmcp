/**
 * Tests for the retrieval eval harness.
 *
 * These pin the harness itself, not the ranker — a scoring harness that is wrong is
 * worse than none, because its numbers get trusted. The legacy ranker in particular
 * must reproduce the ORIGINAL behaviour including its bugs; a "cleaned up" baseline
 * would flatter every comparison against it.
 */

import {
  legacyRanker, shippedRanker,
  precisionAtK, reciprocalRank, ndcgAtK, metaShareAtK,
  type EvalCandidate,
} from '../eval/rankers.js'

const c = (id: string, content: string, over: Partial<EvalCandidate> = {}): EvalCandidate =>
  ({ id, content, confidence: 1, ...over })

describe('legacyRanker — must reproduce pre-#85 behaviour, bugs included', () => {
  it('sorts by confidence first when the gap exceeds 0.1', () => {
    const out = legacyRanker([
      c('low', 'exact query match here', { confidence: 0.5 }),
      c('high', 'nothing to do with it', { confidence: 1 }),
    ], 'exact query match here')
    // Confidence wins outright — this is the defect that made the ranker inert,
    // since every stored entry carries confidence 1.
    expect(out[0].id).toBe('high')
  })

  it('falls through to relevance when confidences are within 0.1', () => {
    const out = legacyRanker([
      c('off', 'unrelated text', { confidence: 1 }),
      c('on', 'ollama timeout classification', { confidence: 0.95 }),
    ], 'ollama timeout classification')
    expect(out[0].id).toBe('on')
  })

  it('matches substrings, not word boundaries (original defect preserved)', () => {
    const out = legacyRanker([
      c('none', 'completely unrelated', { confidence: 1 }),
      c('substr', 'the timeoutvalue setting', { confidence: 1 }),
    ], 'timeout')
    // "timeout" inside "timeoutvalue" counted as a hit for the legacy scorer.
    expect(out[0].id).toBe('substr')
  })
})

describe('shippedRanker', () => {
  it('orders by the _score the service already computed', () => {
    const out = shippedRanker([
      c('b', 'x', { _score: 0.4 }), c('a', 'y', { _score: 0.9 }), c('c', 'z', { _score: 0.6 }),
    ], 'q')
    expect(out.map(r => r.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('metrics', () => {
  const ordered = [c('1', 'a'), c('2', 'b'), c('3', 'c'), c('4', 'd'), c('5', 'e')]
  const labels = { '1': 1, '2': 0, '3': 1, '4': 0, '5': 0 }

  it('precisionAtK divides by k, not by the number returned', () => {
    // A query returning 2 results with 1 relevant is P@5 = 0.2, not 0.5 — otherwise
    // low-recall queries score artificially well.
    expect(precisionAtK(ordered.slice(0, 2), labels, 5)).toBeCloseTo(0.2)
    expect(precisionAtK(ordered, labels, 5)).toBeCloseTo(0.4)
  })

  it('reciprocalRank rewards the first relevant hit by position', () => {
    expect(reciprocalRank(ordered, labels)).toBe(1)
    expect(reciprocalRank([ordered[1], ordered[0]], labels)).toBeCloseTo(0.5)
  })

  it('ndcg separates orderings that P@5 cannot', () => {
    // Same two relevant docs, different positions — P@5 identical, nDCG is not.
    const front = [ordered[0], ordered[2], ordered[1], ordered[3], ordered[4]]
    const back = [ordered[1], ordered[3], ordered[4], ordered[0], ordered[2]]
    expect(precisionAtK(front, labels, 5)).toBeCloseTo(precisionAtK(back, labels, 5))
    expect(ndcgAtK(front, labels, 5)).toBeGreaterThan(ndcgAtK(back, labels, 5))
  })

  it('ndcg is 1 when all relevant docs are ranked first', () => {
    expect(ndcgAtK([ordered[0], ordered[2], ordered[1]], labels, 5)).toBeCloseTo(1)
  })

  it('metaShareAtK counts auto-extracted and meta-subject entries', () => {
    const mixed = [
      c('m1', 'x', { extractedBy: 'kms-session-extract' }),
      c('m2', 'x', { subject: 'KMS.retrieval.audit' }),
      c('d1', 'x', { subject: 'WinFlex.carrier.symetra' }),
      c('d2', 'x', { subject: null }),
    ]
    expect(metaShareAtK(mixed, 4)).toBeCloseTo(0.5)
  })

  it('handles an empty ordering without dividing by zero', () => {
    expect(precisionAtK([], labels, 5)).toBe(0)
    expect(ndcgAtK([], labels, 5)).toBe(0)
    expect(metaShareAtK([], 5)).toBe(0)
    expect(reciprocalRank([], labels)).toBe(0)
  })

  it('ndcg is 0 when nothing is labelled relevant', () => {
    expect(ndcgAtK(ordered, { '1': 0, '2': 0 }, 5)).toBe(0)
  })
})
