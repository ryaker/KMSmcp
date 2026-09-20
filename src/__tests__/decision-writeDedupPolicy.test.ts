/**
 * Write-dedup policy — the deterministic half of Jev Experiment 2.
 *
 * The rules these tests pin are the conservative ones: a duplicate is only proposed when
 * every signal agrees, a conflict escalates unless the texts establish the correction, and
 * nothing the policy can propose deletes or edits an existing entry.
 */

import {
  WRITE_DEDUP_AUTO_ACTIONS,
  WRITE_DEDUP_PROPOSAL_SEVERITY,
  aggregateWriteDedupProposals,
  proposeWriteDedupAction,
  type WriteDedupJudgment,
  type WriteDedupProposal,
} from '../decision/writeDedupPolicy.js'
import { WRITE_DEDUP_RELATIONS, type WriteDedupRelation } from '../decision/writeDedupRelation.js'

/** A judgment with `choice` at probability `p` and the rest spread evenly. */
const judgment = (
  choice: WriteDedupRelation,
  p: number,
  nouls: Partial<WriteDedupJudgment['nouls']> = {},
  confidence = 0.9
): WriteDedupJudgment => {
  const rest = (1 - p) / (WRITE_DEDUP_RELATIONS.length - 1)
  return {
    relation: {
      choice,
      confidence,
      probabilities: Object.fromEntries(WRITE_DEDUP_RELATIONS.map(r => [r, r === choice ? p : rest])),
    },
    nouls: {
      same_subject: 0.95,
      new_adds_information: 0.05,
      claims_conflict: 0.02,
      new_marks_correction: 0.02,
      candidate_marks_correction: 0.02,
      ...nouls,
    },
  }
}

describe('proposeWriteDedupAction', () => {
  describe('duplicate — the costly direction', () => {
    it('proposes a skip only when Choice, confidence and both Nouls agree', () => {
      expect(proposeWriteDedupAction(judgment('duplicate', 0.97))).toEqual({
        proposal: 'suggest_skip_duplicate',
        reasons: ['duplicate_confident', 'adds_no_information'],
      })
    })

    it.each([
      ['probability below 0.9', judgment('duplicate', 0.85), 'duplicate_probability_low'],
      ['low Choice confidence', judgment('duplicate', 0.95, {}, 0.6), 'duplicate_confidence_low'],
      ['same_subject not established', judgment('duplicate', 0.97, { same_subject: 0.6 }), 'same_subject_low'],
      ['the new assertion adds information', judgment('duplicate', 0.97, { new_adds_information: 0.4 }), 'new_adds_information'],
    ])('falls back to review when %s', (_label, j, reason) => {
      const result = proposeWriteDedupAction(j)
      expect(result.proposal).toBe('review')
      expect(result.reasons).toContain(reason)
    })
  })

  describe('contradiction escalates', () => {
    it('on the Choice alone', () => {
      expect(proposeWriteDedupAction(judgment('contradicts', 0.8)).proposal).toBe('escalate_contradiction')
    })

    it('on a minority contradicts probability — escalating is the safe direction', () => {
      const j = judgment('complement', 0.7)
      j.relation.probabilities = { ...j.relation.probabilities, contradicts: 0.27, duplicate: 0.01, supersedes: 0.01, supersedes_reverse: 0.005, unrelated: 0.005 }
      expect(proposeWriteDedupAction(j)).toEqual({ proposal: 'escalate_contradiction', reasons: ['contradicts_probability'] })
    })

    it('on the claims_conflict Noul even when the Choice says duplicate', () => {
      expect(proposeWriteDedupAction(judgment('duplicate', 0.97, { claims_conflict: 0.8 }))).toEqual({
        proposal: 'escalate_contradiction',
        reasons: ['claims_conflict'],
      })
    })

    it('does not escalate an incoherent reading (conflict, but different subjects) — and does not wave it through', () => {
      const result = proposeWriteDedupAction(judgment('contradicts', 0.8, { same_subject: 0.1 }))
      expect(result.proposal).toBe('review')
      expect(result.reasons).toContain('conflict_but_different_subject')
    })
  })

  describe('supersede needs the correcting side to say so', () => {
    it('proposes supersede when the new assertion marks itself a correction — despite the conflict it implies', () => {
      const result = proposeWriteDedupAction(judgment('supersedes', 0.9, { new_marks_correction: 0.9, claims_conflict: 0.95 }))
      expect(result.proposal).toBe('suggest_supersede')
    })

    it('escalates an unmarked "supersedes" that conflicts', () => {
      const result = proposeWriteDedupAction(judgment('supersedes', 0.9, { new_marks_correction: 0.2, claims_conflict: 0.9 }))
      expect(result.proposal).toBe('escalate_contradiction')
    })

    it('reviews an unmarked "supersedes" with no conflict signal', () => {
      expect(proposeWriteDedupAction(judgment('supersedes', 0.9, { new_marks_correction: 0.2 }))).toEqual({
        proposal: 'review',
        reasons: ['supersedes_unsupported'],
      })
    })

    it('proposes keeping the existing entry only when the candidate marks itself the correction', () => {
      expect(proposeWriteDedupAction(judgment('supersedes_reverse', 0.9, { candidate_marks_correction: 0.9, claims_conflict: 0.9 })).proposal)
        .toBe('suggest_keep_existing')
      expect(proposeWriteDedupAction(judgment('supersedes_reverse', 0.9, { candidate_marks_correction: 0.1 })).proposal)
        .toBe('review')
    })

    it('does not propose supersede across subjects', () => {
      expect(proposeWriteDedupAction(judgment('supersedes', 0.9, { new_marks_correction: 0.9, same_subject: 0.5 })).proposal)
        .toBe('review')
    })
  })

  it('stores a confident complement, and an unrelated entry', () => {
    expect(proposeWriteDedupAction(judgment('complement', 0.8, { new_adds_information: 0.9 })).proposal).toBe('store_complement')
    expect(proposeWriteDedupAction(judgment('unrelated', 0.8, { same_subject: 0.05 })).proposal).toBe('store_new')
  })

  it('reviews a Choice that is merely the plurality', () => {
    expect(proposeWriteDedupAction(judgment('complement', 0.4))).toEqual({ proposal: 'review', reasons: ['complement_below_threshold'] })
  })

  it('reviews an option id it does not know', () => {
    const j = judgment('complement', 0.9)
    j.relation.choice = 'merge'
    expect(proposeWriteDedupAction(j).proposal).toBe('review')
  })

  it('can never propose a delete or an in-place edit', () => {
    const proposals: WriteDedupProposal[] = [...WRITE_DEDUP_PROPOSAL_SEVERITY]
    expect(proposals.some(p => /delete|update|edit|reap|flag/.test(p))).toBe(false)
  })
})

describe('aggregateWriteDedupProposals', () => {
  it('takes the most consequential proposal and names its candidate', () => {
    expect(aggregateWriteDedupProposals([
      { id: 'a', proposal: 'store_complement' },
      { id: 'b', proposal: 'escalate_contradiction' },
      { id: 'c', proposal: 'suggest_skip_duplicate' },
    ])).toEqual({ proposal: 'escalate_contradiction', targetId: 'b' })
  })

  it('breaks ties toward the earlier (more similar) candidate', () => {
    expect(aggregateWriteDedupProposals([{ id: 'a', proposal: 'review' }, { id: 'b', proposal: 'review' }])?.targetId).toBe('a')
  })

  it('proposes nothing when no candidate was judged', () => {
    expect(aggregateWriteDedupProposals([{ id: 'a', proposal: null }])).toBeNull()
    expect(aggregateWriteDedupProposals([])).toBeNull()
  })
})

describe('KMS_JEV_WRITE_DEDUP_ACT', () => {
  it('has nothing it may execute — the flag is hard-disabled', () => {
    expect(WRITE_DEDUP_AUTO_ACTIONS.size).toBe(0)
  })
})
