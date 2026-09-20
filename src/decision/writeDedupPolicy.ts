/**
 * Write-dedup policy — deterministic code that turns one pair's judgments into a PROPOSED
 * action. Pure functions; no engine, no storage, no env.
 *
 * The asymmetry everything here is built on: storing an entry that turns out to be
 * redundant costs one extra row that `kms_supersede` / `kms_delete` can retire later.
 * Refusing an entry that was NOT redundant loses knowledge nobody knows is missing. So
 *
 *   - a duplicate is only proposed when the Choice, its confidence, AND two independent
 *     Nouls all agree; anything short of that is `review`, never a quiet skip;
 *   - any sign of a factual conflict escalates, unless the texts themselves establish
 *     which side is the correction;
 *   - the only proposals that touch an existing entry are `suggest_supersede` (which
 *     preserves the old entry and the chain) and `suggest_keep_existing` (which touches
 *     nothing). There is no proposal that deletes, and none that edits in place.
 *
 * Every threshold is a starting point chosen for caution, not a calibrated value: none has
 * been fitted against logged production judgments yet. That fit is what the shadow log is
 * for. Bump the version on any change, threshold or rule.
 */

import type { WriteDedupNoul, WriteDedupRelation } from './writeDedupRelation.js'

export const WRITE_DEDUP_POLICY_VERSION = 'write-dedup-policy/v1'

export type WriteDedupProposal =
  /** Unrelated to the candidate — write as an ordinary new entry. */
  | 'store_new'
  /** Both true, new one adds information — write it, linked via `metadata.related_to`. */
  | 'store_complement'
  /** New assertion restates the candidate — nothing to add. */
  | 'suggest_skip_duplicate'
  /** New assertion is the correction — `action=supersede` against the candidate. */
  | 'suggest_supersede'
  /** The candidate already is the correction — do not write the stale assertion. */
  | 'suggest_keep_existing'
  /** Factual conflict with no established winner — a human decides. */
  | 'escalate_contradiction'
  /** The judgments do not support any of the above firmly enough. */
  | 'review'

/**
 * Most to least consequential. The proposal for a whole write is the most consequential
 * one any candidate produced: a write that contradicts one entry and merely complements
 * four others is a contradiction.
 */
export const WRITE_DEDUP_PROPOSAL_SEVERITY: readonly WriteDedupProposal[] = [
  'escalate_contradiction',
  'suggest_supersede',
  'suggest_keep_existing',
  'suggest_skip_duplicate',
  'review',
  'store_complement',
  'store_new',
]

/**
 * What `KMS_JEV_WRITE_DEDUP_ACT=1` may execute on its own. Empty: the flag is reserved and
 * hard-disabled in this version. A proposal earns a place here only after the shadow log
 * shows it agreeing with what callers actually chose (the `write_dedup_resolution` rows).
 */
export const WRITE_DEDUP_AUTO_ACTIONS: ReadonlySet<WriteDedupProposal> = new Set<WriteDedupProposal>()

export const WRITE_DEDUP_THRESHOLDS = {
  /** At or below this `same_subject`, the pair is treated as about different things. */
  differentSubjectMax: 0.2,
  /** `same_subject` needed before proposing anything that holds back or replaces an entry. */
  sameSubjectMin: 0.8,
  duplicateProbabilityMin: 0.9,
  duplicateConfidenceMin: 0.8,
  /** A duplicate may not add information: `new_adds_information` must be at or below this. */
  duplicateAddsInformationMax: 0.2,
  supersedeProbabilityMin: 0.8,
  /** The correcting side's own wording must mark it as a correction. */
  correctionMarkedMin: 0.7,
  /** Deliberately low — escalating is the safe direction. */
  contradictsProbabilityMin: 0.25,
  claimsConflictMin: 0.5,
  complementProbabilityMin: 0.6,
  unrelatedProbabilityMin: 0.6,
} as const

export interface WriteDedupJudgment {
  relation: {
    choice: WriteDedupRelation | string
    probabilities: Partial<Record<WriteDedupRelation, number>>
    confidence: number
  }
  nouls: Record<WriteDedupNoul, number>
}

export interface WriteDedupProposalResult {
  proposal: WriteDedupProposal
  /** Machine-readable rule ids, in the order they fired — why this proposal, not another. */
  reasons: string[]
}

const T = WRITE_DEDUP_THRESHOLDS

export function proposeWriteDedupAction(judgment: WriteDedupJudgment): WriteDedupProposalResult {
  const { choice, confidence } = judgment.relation
  const p = (relation: WriteDedupRelation): number => judgment.relation.probabilities[relation] ?? 0
  const n = judgment.nouls
  const sameSubject = n.same_subject >= T.sameSubjectMin

  // A correction necessarily conflicts with what it corrects, so the supersede rules run
  // BEFORE the conflict rule — but only when the correcting side's own wording marks it as
  // a correction. Without that, a conflict is just a conflict.
  if (choice === 'supersedes' && p('supersedes') >= T.supersedeProbabilityMin) {
    if (sameSubject && n.new_marks_correction >= T.correctionMarkedMin) {
      return { proposal: 'suggest_supersede', reasons: ['supersedes_confident', 'new_marks_correction'] }
    }
  }
  if (choice === 'supersedes_reverse' && p('supersedes_reverse') >= T.supersedeProbabilityMin) {
    if (sameSubject && n.candidate_marks_correction >= T.correctionMarkedMin) {
      return { proposal: 'suggest_keep_existing', reasons: ['supersedes_reverse_confident', 'candidate_marks_correction'] }
    }
  }

  const conflictReasons: string[] = []
  if (p('contradicts') >= T.contradictsProbabilityMin) conflictReasons.push('contradicts_probability')
  if (n.claims_conflict >= T.claimsConflictMin) conflictReasons.push('claims_conflict')
  if (conflictReasons.length > 0) {
    // "They conflict" and "they are about different things" cannot both hold; do not
    // escalate on an incoherent reading, and do not wave the write through on it either.
    if (n.same_subject <= T.differentSubjectMax) {
      return { proposal: 'review', reasons: [...conflictReasons, 'conflict_but_different_subject'] }
    }
    return { proposal: 'escalate_contradiction', reasons: conflictReasons }
  }

  if (choice === 'supersedes' || choice === 'supersedes_reverse') {
    return { proposal: 'review', reasons: [`${choice}_unsupported`] }
  }

  if (choice === 'duplicate') {
    const failed: string[] = []
    if (p('duplicate') < T.duplicateProbabilityMin) failed.push('duplicate_probability_low')
    if (confidence < T.duplicateConfidenceMin) failed.push('duplicate_confidence_low')
    if (!sameSubject) failed.push('same_subject_low')
    if (n.new_adds_information > T.duplicateAddsInformationMax) failed.push('new_adds_information')
    return failed.length === 0
      ? { proposal: 'suggest_skip_duplicate', reasons: ['duplicate_confident', 'adds_no_information'] }
      : { proposal: 'review', reasons: failed }
  }

  if (choice === 'complement' && p('complement') >= T.complementProbabilityMin && n.same_subject > T.differentSubjectMax) {
    return { proposal: 'store_complement', reasons: ['complement_confident'] }
  }

  if (choice === 'unrelated' && (p('unrelated') >= T.unrelatedProbabilityMin || n.same_subject <= T.differentSubjectMax)) {
    return { proposal: 'store_new', reasons: ['unrelated'] }
  }

  return { proposal: 'review', reasons: [`${choice}_below_threshold`] }
}

/**
 * The proposal for the write as a whole: the most consequential per-candidate proposal,
 * and the candidate that produced it. Ties go to the earlier (more similar) candidate.
 * Null when no candidate was judged — a failed evaluation proposes nothing.
 */
export function aggregateWriteDedupProposals(
  perCandidate: ReadonlyArray<{ id: string; proposal: WriteDedupProposal | null }>
): { proposal: WriteDedupProposal; targetId: string } | null {
  let best: { proposal: WriteDedupProposal; targetId: string; rank: number } | null = null
  for (const candidate of perCandidate) {
    if (candidate.proposal === null) continue
    const rank = WRITE_DEDUP_PROPOSAL_SEVERITY.indexOf(candidate.proposal)
    if (best === null || rank < best.rank) best = { proposal: candidate.proposal, targetId: candidate.id, rank }
  }
  return best ? { proposal: best.proposal, targetId: best.targetId } : null
}
