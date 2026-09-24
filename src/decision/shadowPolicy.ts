/**
 * Shadow reorder policy — deterministic code that decides what the engine's judgments
 * WOULD do to a recall ordering. Pure functions; nothing here calls a model.
 *
 * "Jev makes bounded semantic judgments. Deterministic KMS code decides what those
 * judgments may do." This file is the second sentence.
 *
 * The ordering it produces is logged, never served. It exists so that a later offline
 * comparison can ask "would this have been better?" against relevance labels before
 * anyone is tempted to ship it.
 */

import { EVIDENCE_VALUE_MAX, RECALL_STATUS_OPTIONS, type RecallStatus } from './recallEvidence.js'

/** Bump on any change to the weights, multipliers, thresholds or algorithm below. */
export const SHADOW_POLICY_VERSION = 'recall-shadow-policy/v1'

/**
 * Untuned starting values. Equal weight on the two relevance judgments because nothing
 * has been measured yet — the same reasoning, and the same warning, as the 1.0/1.0 RRF
 * weights in `src/retrieval/hybrid.ts`.
 */
export const SHADOW_WEIGHT_ANSWERS_QUERY = 0.5
export const SHADOW_WEIGHT_EVIDENCE_VALUE = 0.5

/**
 * How much of its evidence score an entry keeps, per status.
 *
 * `contradictory` keeps everything: an entry that disputes the query's premise is the
 * one a reader most needs to see, and demoting it would hide exactly the conflict the
 * correction machinery exists to surface. `historical` is mildly discounted rather than
 * buried — "what did we believe in March" is a legitimate query.
 */
export const SHADOW_STATUS_MULTIPLIER: Record<RecallStatus, number> = {
  current: 1,
  contradictory: 1,
  historical: 0.8,
  superseded_context: 0.5,
  irrelevant: 0.25,
}

/**
 * A candidate at or above either threshold is a "strong deterministic/ontology match"
 * and the shadow ordering may never place it lower than production did.
 *
 * Ontology: `_ontologyScore` is the graph arm's own match strength — a candidate reached
 * by walking `PARENT_OF` from the self node is correct by construction and shares no
 * tokens with the query, which is precisely the case a text-reading judge gets wrong.
 * Lexical: `_relevance` near 1 means the query's terms are all present.
 */
export const PROTECT_ONTOLOGY_SCORE_MIN = 0.8
export const PROTECT_LEXICAL_RELEVANCE_MIN = 0.8

export interface ShadowJudgment {
  /** P(answers_query = yes). */
  answersQuery: number
  /** Full status distribution. Missing options count as probability 0. */
  statusProbabilities: Partial<Record<RecallStatus, number>>
  /** Probability-weighted evidence level, 0 … EVIDENCE_VALUE_MAX. */
  evidenceValue: number
}

/**
 * Shadow score in [0, 1].
 *
 * Uses the whole status distribution (an expected multiplier), not the argmax: a
 * candidate that is 51% `current` / 49% `irrelevant` should not score the same as one
 * that is 99% `current`, and thresholding on the winner would throw that away.
 */
export function shadowScore(j: ShadowJudgment): number {
  const evidence = Math.min(1, Math.max(0, j.evidenceValue / EVIDENCE_VALUE_MAX))
  const base = SHADOW_WEIGHT_ANSWERS_QUERY * j.answersQuery + SHADOW_WEIGHT_EVIDENCE_VALUE * evidence

  let multiplier = 0
  let mass = 0
  for (const option of RECALL_STATUS_OPTIONS) {
    const p = j.statusProbabilities[option] ?? 0
    multiplier += p * SHADOW_STATUS_MULTIPLIER[option]
    mass += p
  }
  // A distribution that does not sum to ~1 is a provider fault; renormalise rather than
  // let missing mass act as a silent demotion.
  const expectedMultiplier = mass > 0 ? multiplier / mass : 1

  return Number((base * expectedMultiplier).toFixed(6))
}

// ── v2 ───────────────────────────────────────────────────────────────────────
//
// `shadowScoreV2` scores the v2 question set (`recall-evidence/v2`): `answers_query` and
// `evidence_value` unchanged, plus three nouls in place of v1's `status` Choice. The status
// Choice's ordered "decide in this order" logic is gone; each rule below applies to its own
// probability independently, in code, which is what jaggedness #7/#8 ask for.
//
// The score itself is deliberately narrow: base × the code-known correction multiplier,
// nothing else. `contains_instruction` and `describes_past_state` were both tried as score
// multipliers (demote-to-zero and a mild discount, respectively) and re-scored offline
// against the 1,200-pair labelled pool (`src/scripts/eval-recall-evidence.ts`,
// `src/scripts/rescore-recall-evidence-variants.ts`, PR #137). The instruction demotion
// made things WORSE: of the 65 candidates it zeroed, 61.5% had Gemma grade >= 1 (44.6%
// grade 2) — it was catching legitimately-stored operational directives ("never run
// Ollama inference on this Mac mini", "always use the OneCLI gateway") as if they were
// prompt injection, not just actual adversarial content. Dropping that rule alone closed
// most of the gap to v1 on the same pool. `contradicts_premise` was never a score
// multiplier (v1 gave `contradictory` ×1 for the same reason: a disputed premise is what a
// reader most needs to see). All three nouls are still asked and still logged, as signals
// a future "conflicts"/injection-review block can route on (R10) — they just do not move a
// candidate's rank on their own until there is evidence they should.
export const SHADOW_POLICY_V2_VERSION = 'recall-shadow-policy/v2'

/** Same multiplier v1 gave `superseded_context` — corrected/replaced status is code-known now. */
export const SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER = 0.5
/**
 * NOT applied by `shadowScoreV2` (see the module comment above) — kept only because
 * `src/scripts/rescore-recall-evidence-variants.ts` reconstructs the discounted variants
 * (B/C) from the same cached answers for comparison, and a second copy of this number
 * there would drift from this one.
 */
export const SHADOW_V2_PAST_STATE_DISCOUNT_WEIGHT = 0.2
/** Above this, `contains_instruction` is logged as a flag. It does not change the score. */
export const SHADOW_V2_INSTRUCTION_FLAG_THRESHOLD = 0.7
/** Above this, `contradicts_premise` is logged as a flag. It does not change the score. */
export const SHADOW_V2_CONTRADICTION_FLAG_THRESHOLD = 0.7

export interface ShadowJudgmentV2 {
  /** P(answers_query = yes). */
  answersQuery: number
  /** Probability-weighted evidence level, 0 … EVIDENCE_VALUE_MAX. */
  evidenceValue: number
  /** P(contains_instruction = yes). Logged as a flag; does not affect `score`. */
  containsInstruction: number
  /** P(describes_past_state = yes). Logged as a probability; does not affect `score`. */
  describesPastState: number
  /** P(contradicts_premise = yes). Logged as a flag; does not affect `score`. */
  contradictsPremise: number
  /** Code-known from metadata (`isCandidateCorrectedOrReplaced`) — never asked of Jev. */
  correctedOrReplaced: boolean
}

export interface ShadowScoreV2Result {
  /** base(answersQuery, evidenceValue) × the correction multiplier. Nothing else. */
  score: number
  /**
   * `containsInstruction` crossed `SHADOW_V2_INSTRUCTION_FLAG_THRESHOLD`. Logging only — see
   * the module comment for why this does not demote. Carried for a future review/injection
   * block to route on, and for auditing the flag's own false-positive rate over time.
   */
  containsInstructionFlag: boolean
  /**
   * `contradictsPremise` crossed `SHADOW_V2_CONTRADICTION_FLAG_THRESHOLD`. For routing to a
   * future "conflicts" block (R10's `route()`), not for reordering — a disputed premise is
   * exactly what a reader needs to see, the same reasoning v1 gave `contradictory` ×1.
   */
  contradictsPremiseFlag: boolean
  /** Raw P(describes_past_state = yes), clamped to [0, 1]. Logged, not thresholded. */
  describesPastStateProbability: number
}

/**
 * Shadow score in [0, 1] for the v2 question set: `base × correction multiplier`, plus the
 * three logged signals (two flags, one raw probability) read off the same judgment. Kept as
 * one function (not score-then-flags) because a caller that logs the score always logs the
 * flags alongside it.
 */
export function shadowScoreV2(j: ShadowJudgmentV2): ShadowScoreV2Result {
  const evidence = Math.min(1, Math.max(0, j.evidenceValue / EVIDENCE_VALUE_MAX))
  const base = SHADOW_WEIGHT_ANSWERS_QUERY * j.answersQuery + SHADOW_WEIGHT_EVIDENCE_VALUE * evidence
  const correctedMultiplier = j.correctedOrReplaced ? SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER : 1

  return {
    score: Number((base * correctedMultiplier).toFixed(6)),
    containsInstructionFlag: j.containsInstruction > SHADOW_V2_INSTRUCTION_FLAG_THRESHOLD,
    contradictsPremiseFlag: j.contradictsPremise > SHADOW_V2_CONTRADICTION_FLAG_THRESHOLD,
    describesPastStateProbability: Math.min(1, Math.max(0, j.describesPastState)),
  }
}

export interface ProtectionSignals {
  _ontologyScore?: unknown
  _relevance?: unknown
}

/** Why a candidate is protected, or null. The reason is logged, so keep it specific. */
export function protectionReason(c: ProtectionSignals): 'ontology_match' | 'lexical_match' | null {
  if (typeof c._ontologyScore === 'number' && c._ontologyScore >= PROTECT_ONTOLOGY_SCORE_MIN) return 'ontology_match'
  if (typeof c._relevance === 'number' && c._relevance >= PROTECT_LEXICAL_RELEVANCE_MIN) return 'lexical_match'
  return null
}

export interface ShadowOrderInput {
  id: string
  /** null when the evaluation failed — an unjudged candidate is never moved down. */
  shadowScore: number | null
  protected: boolean
}

/**
 * The ordering the judgments would produce — always a permutation of the input.
 *
 * `inputs` must be in production order, best first: a candidate's position in the array
 * IS its production position. There is deliberately no separate rank field — one that
 * could disagree with the array (duplicates, gaps) would make invariant 2 unfalsifiable.
 *
 * Two invariants, both tested:
 *  1. Nothing is dropped. There is no score below which a candidate disappears; the
 *     worst a judgment can do is move it to the end.
 *  2. A pinned candidate — protected, or unjudged — ends at an index <= its production
 *     position. It may be promoted, never demoted.
 *
 * Invariant 2 holds because pins are re-seated in ascending production order: moving a
 * candidate up to index j only shifts entries that sat between j and its old position,
 * and every pin already seated sits at an index below j.
 */
export function shadowOrder(inputs: ShadowOrderInput[]): string[] {
  // Unjudged candidates have no score to sort on: send them to the end and let the pin
  // pass below restore them. `sort` is stable, so ties keep production order.
  const proposed = [...inputs].sort((a, b) => (b.shadowScore ?? -1) - (a.shadowScore ?? -1))

  inputs.forEach((candidate, target) => {
    if (!candidate.protected && candidate.shadowScore !== null) return
    const at = proposed.indexOf(candidate)
    if (at > target) {
      proposed.splice(at, 1)
      proposed.splice(target, 0, candidate)
    }
  })

  return proposed.map(c => c.id)
}
