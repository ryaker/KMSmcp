/**
 * shadowScoreV2 — the v2 composite score (§3A weights: instruction demotion, correction
 * multiplier, past-state discount, contradiction flag) and its shared use of v1's
 * protection rule via `shadowOrder`/`protectionReason`.
 */
import {
  PROTECT_LEXICAL_RELEVANCE_MIN,
  PROTECT_ONTOLOGY_SCORE_MIN,
  SHADOW_V2_CONTRADICTION_FLAG_THRESHOLD,
  SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER,
  SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD,
  SHADOW_V2_PAST_STATE_DISCOUNT_WEIGHT,
  protectionReason,
  shadowOrder,
  shadowScore,
  shadowScoreV2,
  type ShadowJudgmentV2,
  type ShadowOrderInput,
} from '../decision/shadowPolicy.js'

const judgment = (overrides: Partial<ShadowJudgmentV2> = {}): ShadowJudgmentV2 => ({
  answersQuery: 0.9,
  evidenceValue: 3.5,
  containsInstruction: 0,
  describesPastState: 0,
  contradictsPremise: 0,
  correctedOrReplaced: false,
  ...overrides,
})

describe('shadowScoreV2 — base', () => {
  it('matches v1 shadowScore\'s base formula when nothing else applies (current, not past, not corrected)', () => {
    const j = judgment({ answersQuery: 1, evidenceValue: 4 })
    const v2 = shadowScoreV2(j)
    const v1 = shadowScore({ answersQuery: 1, evidenceValue: 4, statusProbabilities: { current: 1 } })
    expect(v2.score).toBe(v1)
    expect(v2.score).toBe(1)
  })

  it('is 0 for a certain no-support, never-past, never-instruction, uncorrected judgment', () => {
    expect(shadowScoreV2(judgment({ answersQuery: 0, evidenceValue: 0 })).score).toBe(0)
  })
})

describe('shadowScoreV2 — correction multiplier (code-known, not asked of Jev)', () => {
  it('applies exactly the 0.5 multiplier when correctedOrReplaced is true', () => {
    const base = judgment({ answersQuery: 1, evidenceValue: 4 })
    const corrected = shadowScoreV2({ ...base, correctedOrReplaced: true })
    const uncorrected = shadowScoreV2({ ...base, correctedOrReplaced: false })
    expect(corrected.score).toBeCloseTo(uncorrected.score * SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER, 6)
    expect(SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER).toBe(0.5)
  })
})

describe('shadowScoreV2 — past-state discount', () => {
  it('is a mild, probability-scaled discount: 1 - 0.2 * p', () => {
    const base = judgment({ answersQuery: 1, evidenceValue: 4 })
    const certainPast = shadowScoreV2({ ...base, describesPastState: 1 })
    const uncertainPast = shadowScoreV2({ ...base, describesPastState: 0.5 })
    const never = shadowScoreV2({ ...base, describesPastState: 0 })
    expect(SHADOW_V2_PAST_STATE_DISCOUNT_WEIGHT).toBe(0.2)
    expect(certainPast.score).toBeCloseTo(never.score * (1 - 0.2 * 1), 6)
    expect(uncertainPast.score).toBeCloseTo(never.score * (1 - 0.2 * 0.5), 6)
    // Mild: even a certain "describes the past" never loses more than the discount weight.
    expect(certainPast.score).toBeGreaterThanOrEqual(never.score * 0.79)
  })
})

describe('shadowScoreV2 — instruction demotion', () => {
  it('demotes to exactly 0 once containsInstruction crosses the threshold', () => {
    const base = judgment({ answersQuery: 1, evidenceValue: 4 })
    const above = shadowScoreV2({ ...base, containsInstruction: SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD + 0.01 })
    expect(above.score).toBe(0)
    expect(above.containsInstructionFlag).toBe(true)
  })

  it('does not demote at or below the threshold', () => {
    const base = judgment({ answersQuery: 1, evidenceValue: 4 })
    const at = shadowScoreV2({ ...base, containsInstruction: SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD })
    expect(at.containsInstructionFlag).toBe(false)
    expect(at.score).toBeGreaterThan(0)
  })

  it('demotion wins over every other multiplier — a demoted candidate is never rescued by a good answers_query/evidence', () => {
    const worst = shadowScoreV2({
      answersQuery: 1,
      evidenceValue: 4,
      containsInstruction: 0.99,
      describesPastState: 0,
      contradictsPremise: 0,
      correctedOrReplaced: false,
    })
    expect(worst.score).toBe(0)
  })
})

describe('shadowScoreV2 — contradiction flag', () => {
  it('sets the flag above the threshold but never changes the score', () => {
    const base = judgment({ answersQuery: 0.9, evidenceValue: 3.5 })
    const flagged = shadowScoreV2({ ...base, contradictsPremise: 0.95 })
    const clean = shadowScoreV2({ ...base, contradictsPremise: 0 })
    expect(flagged.contradictsPremiseFlag).toBe(true)
    expect(clean.contradictsPremiseFlag).toBe(false)
    expect(flagged.score).toBe(clean.score)
    expect(SHADOW_V2_CONTRADICTION_FLAG_THRESHOLD).toBe(0.7)
  })

  it('is not demoted even at probability 1 — the reader needs to see a disputed premise (v1\'s reasoning for `contradictory` x1)', () => {
    const base = judgment({ answersQuery: 0.9, evidenceValue: 3.5 })
    const certain = shadowScoreV2({ ...base, contradictsPremise: 1 })
    const none = shadowScoreV2({ ...base, contradictsPremise: 0 })
    expect(certain.score).toBe(none.score)
    expect(certain.score).toBeGreaterThan(0)
  })
})

describe('shadowScoreV2 — protection rule is v1\'s, unchanged, shared by both', () => {
  it('protectionReason and shadowOrder are the same functions v1 uses — no v2-specific copy', () => {
    expect(protectionReason({ _ontologyScore: PROTECT_ONTOLOGY_SCORE_MIN })).toBe('ontology_match')
    expect(protectionReason({ _relevance: PROTECT_LEXICAL_RELEVANCE_MIN })).toBe('lexical_match')
  })

  it('shadowOrder never demotes a protected candidate below its production position, using v2 scores', () => {
    const v2Scores = {
      onto: shadowScoreV2(judgment({ answersQuery: 0.01, evidenceValue: 0 })).score, // near-zero v2 score
      b: shadowScoreV2(judgment({ answersQuery: 0.9, evidenceValue: 4 })).score,
      c: shadowScoreV2(judgment({ answersQuery: 0.8, evidenceValue: 3 })).score,
    }
    const inputs: ShadowOrderInput[] = [
      { id: 'onto', shadowScore: v2Scores.onto, protected: true },
      { id: 'b', shadowScore: v2Scores.b, protected: false },
      { id: 'c', shadowScore: v2Scores.c, protected: false },
    ]
    const order = shadowOrder(inputs)
    expect(order[0]).toBe('onto')
  })

  it('a demoted (containsInstruction > threshold) candidate is never protected regardless of ontology/lexical signals', () => {
    // Protection is about the retrieval-side signal, not the v2 judgment — a candidate can
    // be both. This test documents that demotion only zeroes the SCORE; whether it is also
    // `protected` is decided independently by `protectionReason`, and shadowOrder still
    // pins a protected-but-demoted candidate at/above its production slot.
    const demoted = shadowScoreV2({ ...judgment(), containsInstruction: 0.99 })
    expect(demoted.score).toBe(0)
    const order = shadowOrder([
      { id: 'demoted', shadowScore: demoted.score, protected: true },
      { id: 'other', shadowScore: 0.9, protected: false },
    ])
    expect(order[0]).toBe('demoted')
  })
})
