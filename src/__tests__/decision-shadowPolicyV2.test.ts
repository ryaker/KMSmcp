/**
 * shadowScoreV2 — the v2 composite score, now variant D from the offline re-score
 * (PR #137, `src/scripts/rescore-recall-evidence-variants.ts`): `score = base ×
 * code-known correction multiplier`, full stop. `contains_instruction`,
 * `contradicts_premise` and `describes_past_state` are logged (two flags, one raw
 * probability) but never move the score. Also covers the shared use of v1's protection
 * rule via `shadowOrder`/`protectionReason`.
 */
import {
  PROTECT_LEXICAL_RELEVANCE_MIN,
  PROTECT_ONTOLOGY_SCORE_MIN,
  SHADOW_V2_CONTRADICTION_FLAG_THRESHOLD,
  SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER,
  SHADOW_V2_INSTRUCTION_FLAG_THRESHOLD,
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
  it('matches v1 shadowScore\'s base formula when nothing else applies (not corrected)', () => {
    const j = judgment({ answersQuery: 1, evidenceValue: 4 })
    const v2 = shadowScoreV2(j)
    const v1 = shadowScore({ answersQuery: 1, evidenceValue: 4, statusProbabilities: { current: 1 } })
    expect(v2.score).toBe(v1)
    expect(v2.score).toBe(1)
  })

  it('is 0 for a certain no-support, uncorrected judgment', () => {
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

  it('is the ONLY multiplier the shipped score applies — the whole formula is base × this', () => {
    const j = judgment({ answersQuery: 0.8, evidenceValue: 3, correctedOrReplaced: true })
    const evidence = 3 / 4
    const base = 0.5 * 0.8 + 0.5 * evidence
    expect(shadowScoreV2(j).score).toBeCloseTo(base * SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER, 6)
  })
})

describe('shadowScoreV2 — describes_past_state is logged, not scored', () => {
  it('never changes the score, at any probability', () => {
    const base = judgment({ answersQuery: 1, evidenceValue: 4 })
    const certainPast = shadowScoreV2({ ...base, describesPastState: 1 })
    const uncertainPast = shadowScoreV2({ ...base, describesPastState: 0.5 })
    const never = shadowScoreV2({ ...base, describesPastState: 0 })
    expect(certainPast.score).toBe(never.score)
    expect(uncertainPast.score).toBe(never.score)
  })

  it('is carried through as the raw clamped probability, for logging', () => {
    expect(shadowScoreV2(judgment({ describesPastState: 0.42 })).describesPastStateProbability).toBe(0.42)
    expect(shadowScoreV2(judgment({ describesPastState: 1.5 })).describesPastStateProbability).toBe(1)
    expect(shadowScoreV2(judgment({ describesPastState: -0.5 })).describesPastStateProbability).toBe(0)
  })
})

describe('shadowScoreV2 — contains_instruction: flagged, not demoted', () => {
  // Dropped from the score in the same PR that shipped it (#137): re-scoring the 1,200-pair
  // labelled pool showed the instruction demotion was net-negative. Of the 65 candidates it
  // zeroed, 61.5% had Gemma grade >= 1 (44.6% strictly grade 2) — the noul was firing on
  // legitimately-stored operational directives ("never run Ollama inference on this Mac
  // mini", "always use the OneCLI gateway"), not just adversarial prompt-injection content.
  // The flag stays (still useful signal for a future review/injection block, R10's
  // `route()`), but it no longer moves a candidate's rank on its own.
  it('never changes the score, even at probability 1', () => {
    const base = judgment({ answersQuery: 1, evidenceValue: 4 })
    const flagged = shadowScoreV2({ ...base, containsInstruction: 1 })
    const clean = shadowScoreV2({ ...base, containsInstruction: 0 })
    expect(flagged.score).toBe(clean.score)
    expect(flagged.score).toBeGreaterThan(0)
  })

  it('sets containsInstructionFlag strictly above the threshold', () => {
    const base = judgment({ answersQuery: 1, evidenceValue: 4 })
    const above = shadowScoreV2({ ...base, containsInstruction: SHADOW_V2_INSTRUCTION_FLAG_THRESHOLD + 0.01 })
    const at = shadowScoreV2({ ...base, containsInstruction: SHADOW_V2_INSTRUCTION_FLAG_THRESHOLD })
    expect(above.containsInstructionFlag).toBe(true)
    expect(at.containsInstructionFlag).toBe(false)
    expect(SHADOW_V2_INSTRUCTION_FLAG_THRESHOLD).toBe(0.7)
  })

  it('a flagged candidate keeps whatever score its answers_query/evidence/correction earned — nothing rescues or punishes it beyond that', () => {
    const flaggedButStrong = shadowScoreV2({
      answersQuery: 1,
      evidenceValue: 4,
      containsInstruction: 0.99,
      describesPastState: 0,
      contradictsPremise: 0,
      correctedOrReplaced: false,
    })
    expect(flaggedButStrong.score).toBe(1)
    expect(flaggedButStrong.containsInstructionFlag).toBe(true)
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

  it('ranks a flagged-but-relevant candidate on its real score, exactly the case the offline re-score found the old demotion was losing', () => {
    // The 61.5%-relevant finding, as an ordering: an instruction-flagged candidate that
    // genuinely answers the query should still beat a weak, unflagged one — the old
    // demote-to-zero rule would have buried it regardless.
    const strongButFlagged = shadowScoreV2(judgment({ answersQuery: 0.95, evidenceValue: 4, containsInstruction: 0.9 })).score
    const weakClean = shadowScoreV2(judgment({ answersQuery: 0.2, evidenceValue: 1 })).score
    const order = shadowOrder([
      { id: 'flagged', shadowScore: strongButFlagged, protected: false },
      { id: 'weak', shadowScore: weakClean, protected: false },
    ])
    expect(order).toEqual(['flagged', 'weak'])
  })
})
