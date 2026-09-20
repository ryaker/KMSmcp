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
