/**
 * Cache-only variant re-score — pure functions only. No network, no file I/O beyond what
 * the test itself constructs in memory: `variantScore`'s five configurations,
 * `findCacheMisses`'s miss detection, and the instruction-flagged grade breakdown.
 */
import {
  VARIANTS,
  findCacheMisses,
  instructionFlaggedGradeBreakdown,
  variantScore,
  type VariantConfig,
} from '../scripts/rescore-recall-evidence-variants.js'
import {
  SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER,
  SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD,
  SHADOW_V2_PAST_STATE_DISCOUNT_WEIGHT,
} from '../decision/shadowPolicy.js'
import { buildRecallStateV2, fingerprintRecallStateV2 } from '../decision/recallEvidence.js'
import type { CachedAnswer, PoolQuery } from '../scripts/eval-recall-evidence.js'

const answer = (overrides: Partial<CachedAnswer> = {}): CachedAnswer => ({
  answers_query: 0.9,
  evidence_value: 3.6,
  contradicts_premise: 0,
  contains_instruction: 0,
  describes_past_state: 0,
  model: 'jev-1.13.0',
  input_tokens: 400,
  output_tokens: 0,
  cost_usd_estimate: 0.0000168,
  ...overrides,
})

const variantById = (id: string): VariantConfig => {
  const v = VARIANTS.find(x => x.id === id)
  if (!v) throw new Error(`no such variant: ${id}`)
  return v
}

describe('VARIANTS — the five configurations the coordinator asked for', () => {
  it('has exactly A through E, in order', () => {
    expect(VARIANTS.map(v => v.id)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('A is v2-as-shipped: all three rules on', () => {
    const a = variantById('A')
    expect(a).toMatchObject({ applyInstructionDemotion: true, applyPastStateDiscount: true, applyCorrectionMultiplier: true })
  })

  it('E is base-only: everything off', () => {
    const e = variantById('E')
    expect(e).toMatchObject({ applyInstructionDemotion: false, applyPastStateDiscount: false, applyCorrectionMultiplier: false })
  })
})

describe('variantScore', () => {
  const base = answer({ answers_query: 1, evidence_value: 4 }) // base term = 1

  it('A demotes to exactly 0 above the instruction threshold, same threshold shadowScoreV2 uses', () => {
    const flagged = answer({ ...base, contains_instruction: SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD + 0.01 })
    expect(variantScore(flagged, variantById('A'))).toBe(0)
  })

  it('B does NOT demote even at contains_instruction = 1 — the whole point of the variant', () => {
    const flagged = answer({ ...base, contains_instruction: 1 })
    expect(variantScore(flagged, variantById('B'))).toBeGreaterThan(0)
    expect(variantScore(flagged, variantById('B'))).toBe(1) // base=1, no other multiplier active
  })

  it('C drops the past-state discount but keeps instruction demotion', () => {
    const past = answer({ ...base, describes_past_state: 1 })
    expect(variantScore(past, variantById('C'))).toBe(1) // discount off -> full base
    const flagged = answer({ ...base, contains_instruction: 0.99 })
    expect(variantScore(flagged, variantById('C'))).toBe(0) // demotion still on
  })

  it('D and E agree whenever correctedOrReplaced is false — the only difference between them is a multiplier that never fires here', () => {
    const j = answer({ answers_query: 0.6, evidence_value: 2 })
    expect(variantScore(j, variantById('D'), false)).toBe(variantScore(j, variantById('E'), false))
  })

  it('D and E diverge once correctedOrReplaced is true — D applies the 0.5x multiplier, E never does', () => {
    const j = answer({ answers_query: 1, evidence_value: 4 })
    const d = variantScore(j, variantById('D'), true)
    const e = variantScore(j, variantById('E'), true)
    expect(d).toBeCloseTo(1 * SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER, 6)
    expect(e).toBe(1)
    expect(d).not.toBe(e)
  })

  it('the past-state discount is exactly 1 - weight*p, matching shadowScoreV2\'s constant', () => {
    const j = answer({ answers_query: 1, evidence_value: 4, describes_past_state: 0.5 })
    const scored = variantScore(j, variantById('A'))
    expect(scored).toBeCloseTo(1 * (1 - SHADOW_V2_PAST_STATE_DISCOUNT_WEIGHT * 0.5), 6)
  })
})

describe('findCacheMisses', () => {
  const pool: PoolQuery[] = [
    {
      query: 'q1',
      candidates: [
        { id: 'c1', prod_rank: 1, content: 'hello', jevA: 0.5, jevB: 0.5, grade: 1 },
        { id: 'c2', prod_rank: 2, content: 'world', jevA: 0.4, jevB: 0.4, grade: 0 },
      ],
    },
  ]

  it('reports zero misses when every pair\'s fingerprint is in the cache map', () => {
    // Build the cache the same way `eval-recall-evidence.ts` does: fingerprint of
    // buildRecallStateV2(query, candidate). Round-tripping through the real functions
    // (not a hardcoded fingerprint literal) means this test breaks, honestly, if the v2
    // state shape ever changes instead of silently going stale.
    const cache = new Map<string, CachedAnswer>()
    for (const q of pool) {
      for (const c of q.candidates) {
        const state = buildRecallStateV2(q.query, { id: c.id, content: c.content })
        cache.set(fingerprintRecallStateV2(state), answer())
      }
    }
    const { missing, answersByQuery } = findCacheMisses(pool, cache)
    expect(missing).toEqual([])
    expect(answersByQuery.get(0)?.size).toBe(2)
  })

  it('reports a MissingPair with query index, query text and candidate id for every uncached pair', () => {
    const { missing, answersByQuery } = findCacheMisses(pool, new Map())
    expect(missing).toEqual([
      { queryIndex: 0, query: 'q1', candidateId: 'c1' },
      { queryIndex: 0, query: 'q1', candidateId: 'c2' },
    ])
    // A missing pair still gets an (empty) entry in answersByQuery for its query index —
    // callers key off the map without a null-check per query.
    expect(answersByQuery.get(0)?.size).toBe(0)
  })
})

describe('instructionFlaggedGradeBreakdown', () => {
  const pool: PoolQuery[] = [
    {
      query: 'q1',
      candidates: [
        { id: 'a', prod_rank: 1, content: '', jevA: 0, jevB: 0, grade: 2 },
        { id: 'b', prod_rank: 2, content: '', jevA: 0, jevB: 0, grade: 1 },
        { id: 'c', prod_rank: 3, content: '', jevA: 0, jevB: 0, grade: 0 },
        { id: 'd', prod_rank: 4, content: '', jevA: 0, jevB: 0, grade: 2 }, // not flagged
      ],
    },
  ]

  it('counts only candidates strictly above the threshold, split by grade', () => {
    const answersByQuery = new Map([
      [
        0,
        new Map<string, CachedAnswer>([
          ['a', answer({ contains_instruction: 0.9 })],
          ['b', answer({ contains_instruction: 0.85 })],
          ['c', answer({ contains_instruction: 0.71 })],
          ['d', answer({ contains_instruction: 0.5 })], // below threshold — excluded
        ]),
      ],
    ])
    const result = instructionFlaggedGradeBreakdown(pool, answersByQuery)
    expect(result).toEqual({ total: 3, grade2: 1, grade1: 1, grade0: 1 })
  })

  it('is all zero when no query has any cached answers', () => {
    expect(instructionFlaggedGradeBreakdown(pool, new Map())).toEqual({ total: 0, grade2: 0, grade1: 0, grade0: 0 })
  })
})
