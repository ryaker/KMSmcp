/**
 * Shadow reorder policy — the deterministic half of Experiment 1.
 *
 * The two invariants that make a shadow ordering safe to even look at: it is always a
 * permutation (nothing dropped), and a strong deterministic/ontology match — or a
 * candidate the engine failed to judge — is never moved DOWN.
 */

import {
  PROTECT_LEXICAL_RELEVANCE_MIN,
  PROTECT_ONTOLOGY_SCORE_MIN,
  protectionReason,
  shadowOrder,
  shadowScore,
  type ShadowOrderInput,
} from '../decision/shadowPolicy.js'

// The second argument is the production position, kept at each call site so a test reads
// as "candidate X, served at position N". It is documentation only: shadowOrder takes
// production order from the array itself.
const input = (id: string, _position: number, score: number | null, isProtected = false): ShadowOrderInput =>
  ({ id, shadowScore: score, protected: isProtected })

describe('shadowScore', () => {
  it('is 1 for a certain, current, direct answer and 0 for certain no-support', () => {
    expect(shadowScore({ answersQuery: 1, statusProbabilities: { current: 1 }, evidenceValue: 4 })).toBe(1)
    expect(shadowScore({ answersQuery: 0, statusProbabilities: { current: 1 }, evidenceValue: 0 })).toBe(0)
  })

  it('uses the whole status distribution, not the argmax', () => {
    const certain = shadowScore({ answersQuery: 1, statusProbabilities: { current: 0.99, irrelevant: 0.01 }, evidenceValue: 4 })
    const split = shadowScore({ answersQuery: 1, statusProbabilities: { current: 0.51, irrelevant: 0.49 }, evidenceValue: 4 })
    // Both pick `current`; a policy that thresholded on the winner would score them equal.
    expect(split).toBeLessThan(certain)
  })

  it('does not demote a contradictory entry — a disputed premise is what the reader needs to see', () => {
    const judgment = { answersQuery: 0.9, evidenceValue: 3.5 }
    expect(shadowScore({ ...judgment, statusProbabilities: { contradictory: 1 } }))
      .toBe(shadowScore({ ...judgment, statusProbabilities: { current: 1 } }))
  })

  it('orders the statuses current > historical > superseded_context > irrelevant', () => {
    const at = (status: string) => shadowScore({ answersQuery: 0.8, evidenceValue: 3, statusProbabilities: { [status]: 1 } })
    expect(at('current')).toBeGreaterThan(at('historical'))
    expect(at('historical')).toBeGreaterThan(at('superseded_context'))
    expect(at('superseded_context')).toBeGreaterThan(at('irrelevant'))
  })

  it('renormalises a distribution with missing mass instead of treating it as a demotion', () => {
    expect(shadowScore({ answersQuery: 1, statusProbabilities: { current: 0.5 }, evidenceValue: 4 })).toBe(1)
    expect(shadowScore({ answersQuery: 1, statusProbabilities: {}, evidenceValue: 4 })).toBe(1)
  })
})

describe('protectionReason', () => {
  it('protects a strong ontology match, then a strong lexical match, and nothing else', () => {
    expect(protectionReason({ _ontologyScore: PROTECT_ONTOLOGY_SCORE_MIN })).toBe('ontology_match')
    expect(protectionReason({ _relevance: PROTECT_LEXICAL_RELEVANCE_MIN })).toBe('lexical_match')
    expect(protectionReason({ _ontologyScore: 0.79, _relevance: 0.79 })).toBeNull()
    expect(protectionReason({})).toBeNull()
  })

  it('ignores non-numeric signals rather than coercing them', () => {
    expect(protectionReason({ _ontologyScore: '0.95', _relevance: null })).toBeNull()
  })
})

describe('shadowOrder', () => {
  it('sorts unprotected candidates by shadow score', () => {
    expect(shadowOrder([input('a', 0, 0.1), input('b', 1, 0.9), input('c', 2, 0.5)])).toEqual(['b', 'c', 'a'])
  })

  it('never moves a protected candidate below its production position', () => {
    // `onto` is an ontology card: correct by graph traversal, shares no tokens with the
    // query, and a text-reading judge scores it near zero.
    const order = shadowOrder([input('onto', 0, 0.02, true), input('b', 1, 0.9), input('c', 2, 0.8)])
    expect(order[0]).toBe('onto')
    expect(order).toEqual(['onto', 'b', 'c'])
  })

  it('still lets a protected candidate be promoted', () => {
    expect(shadowOrder([input('a', 0, 0.2), input('b', 1, 0.3), input('p', 2, 0.95, true)])).toEqual(['p', 'b', 'a'])
  })

  it('treats an unjudged candidate as pinned — a failed call must not read as a bad score', () => {
    const order = shadowOrder([input('a', 0, 0.4), input('failed', 1, null), input('c', 2, 0.9), input('d', 3, 0.8)])
    expect(order.indexOf('failed')).toBeLessThanOrEqual(1)
    expect(order).toEqual(['c', 'failed', 'd', 'a'])
  })

  it('breaks score ties by production order', () => {
    expect(shadowOrder([input('a', 0, 0.5), input('b', 1, 0.5), input('c', 2, 0.5)])).toEqual(['a', 'b', 'c'])
  })

  it('holds both invariants over randomised inputs', () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 20260919
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32

    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 25)
      const inputs = Array.from({ length: n }, (_, i) =>
        input(`c${i}`, i, rand() < 0.15 ? null : Number(rand().toFixed(3)), rand() < 0.3))
      const order = shadowOrder(inputs)

      expect([...order].sort()).toEqual(inputs.map(c => c.id).sort())
      inputs.forEach((c, productionPosition) => {
        if (c.protected || c.shadowScore === null) {
          expect(order.indexOf(c.id)).toBeLessThanOrEqual(productionPosition)
        }
      })
    }
  })

  it('takes production order from the array — there is no separate rank a caller could get wrong', () => {
    // Three protected candidates: each must stay at or above the slot it arrived in.
    const order = shadowOrder([input('p1', 0, 0.1, true), input('p2', 1, 0.5, true), input('p3', 2, 0.9, true)])
    expect(order).toEqual(['p1', 'p2', 'p3'])
    expect(Object.keys(input('x', 0, 0.5))).toEqual(['id', 'shadowScore', 'protected'])
  })

  it('does not mutate its input', () => {
    const inputs = [input('a', 0, 0.1), input('b', 1, 0.9)]
    const snapshot = JSON.stringify(inputs)
    shadowOrder(inputs)
    expect(JSON.stringify(inputs)).toBe(snapshot)
  })
})
