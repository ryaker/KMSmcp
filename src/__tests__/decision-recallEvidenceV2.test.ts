/**
 * recall-evidence/v2 — question shape, state builder, and the code-side helpers that
 * replace what v1's `status` Choice asked Jev to compare (R5/R6). No network: this only
 * exercises pure functions and the question objects themselves.
 */
import {
  RECALL_EVIDENCE_QUESTIONS,
  RECALL_EVIDENCE_QUESTIONS_V2,
  RECALL_EVIDENCE_SCHEMA_VERSION,
  RECALL_EVIDENCE_V2_SCHEMA_VERSION,
  buildRecallStateV2,
  fingerprintRecallStateV2,
  isCandidateCorrectedOrReplaced,
  recallCandidateAgeBucket,
  type RecallCandidate,
} from '../decision/recallEvidence.js'

describe('RECALL_EVIDENCE_QUESTIONS_V2 — shape', () => {
  it('has exactly the five questions the redesign specifies, none of them a Choice', () => {
    expect(Object.keys(RECALL_EVIDENCE_QUESTIONS_V2).sort()).toEqual(
      ['answers_query', 'contains_instruction', 'contradicts_premise', 'describes_past_state', 'evidence_value'].sort()
    )
    for (const [id, q] of Object.entries(RECALL_EVIDENCE_QUESTIONS_V2)) {
      expect(q.type === 'noul' || q.type === 'score').toBe(true)
      // The redesign's whole point: no ordered "decide in this order" Choice logic left in
      // a question — that belongs in code (shadowScoreV2), never asked of the model again.
      expect(q.type).not.toBe('choice')
      expect(typeof q.instructions).toBe('string')
      expect(q.instructions.length).toBeGreaterThan(0)
      void id
    }
  })

  it('keeps answers_query and evidence_value as the literal v1 question objects — same wording, no drift', () => {
    expect(RECALL_EVIDENCE_QUESTIONS_V2.answers_query).toBe(RECALL_EVIDENCE_QUESTIONS.answers_query)
    expect(RECALL_EVIDENCE_QUESTIONS_V2.evidence_value).toBe(RECALL_EVIDENCE_QUESTIONS.evidence_value)
  })

  it('the three new nouls have true/false criteria and no reference to a date or "today"', () => {
    for (const id of ['contradicts_premise', 'contains_instruction', 'describes_past_state'] as const) {
      const q = RECALL_EVIDENCE_QUESTIONS_V2[id]
      expect(q.type).toBe('noul')
      if (q.type !== 'noul') throw new Error('unreachable')
      expect(q.criteria?.true).toBeTruthy()
      expect(q.criteria?.false).toBeTruthy()
      expect(q.instructions.toLowerCase()).not.toMatch(/\btoday\b/)
      expect(q.instructions.toLowerCase()).not.toMatch(/\bstored_at\b/)
      expect(q.instructions.toLowerCase()).not.toMatch(/\bdate\b/)
    }
  })

  it('contains_instruction asks about the addressee (assistant/agent), not mere imperative wording', () => {
    const q = RECALL_EVIDENCE_QUESTIONS_V2.contains_instruction
    if (q.type !== 'noul') throw new Error('unreachable')
    expect(q.instructions).toMatch(/assistant|agent/i)
    expect(q.criteria?.false ?? '').toMatch(/human/i)
  })

  it('is a different schema version from v1 — a v1 log row is never comparable to a v2 one', () => {
    expect(RECALL_EVIDENCE_V2_SCHEMA_VERSION).not.toBe(RECALL_EVIDENCE_SCHEMA_VERSION)
    expect(RECALL_EVIDENCE_V2_SCHEMA_VERSION).toBe('recall-evidence/v2')
  })
})

describe('buildRecallStateV2', () => {
  const candidate: RecallCandidate = {
    id: 'c1',
    content: 'The deploy runs at 09:00 UTC.',
    contentType: 'procedure',
    timestamp: '2026-01-01T00:00:00Z',
    metadata: { subject: 'CI.deploy_schedule', flag: 'SUPERSEDED', supersedes: 'older-id' },
  }

  it('never includes today, stored_at, or any correction/replace field — those are code-only inputs now', () => {
    const state = buildRecallStateV2('when does the deploy run?', candidate) as Record<string, unknown>
    expect(state).not.toHaveProperty('today')
    const c = state.candidate as Record<string, unknown>
    expect(c).not.toHaveProperty('stored_at')
    expect(c).not.toHaveProperty('correction_flag')
    expect(c).not.toHaveProperty('replaced_by_later_entry')
    expect(c).not.toHaveProperty('replaces_earlier_entry')
    expect(c).not.toHaveProperty('times_edited')
  })

  it('carries query, content, truncation, content_type and subject', () => {
    const state = buildRecallStateV2('q', candidate) as { query: string; candidate: Record<string, unknown> }
    expect(state.query).toBe('q')
    expect(state.candidate.content).toBe(candidate.content)
    expect(state.candidate.content_truncated).toBe(false)
    expect(state.candidate.content_type).toBe('procedure')
    expect(state.candidate.subject).toBe('CI.deploy_schedule')
  })

  it('truncates at RECALL_CANDIDATE_MAX_CHARS and records it, same cap as v1', () => {
    const long: RecallCandidate = { content: 'x'.repeat(7000) }
    const state = buildRecallStateV2('q', long) as { candidate: { content: string; content_truncated: boolean } }
    expect(state.candidate.content_truncated).toBe(true)
    expect(state.candidate.content.length).toBe(6000)
  })

  it('fingerprints deterministically and changes when the content changes', () => {
    const s1 = buildRecallStateV2('q', candidate)
    const s2 = buildRecallStateV2('q', candidate)
    const s3 = buildRecallStateV2('q', { ...candidate, content: 'different' })
    expect(fingerprintRecallStateV2(s1)).toBe(fingerprintRecallStateV2(s2))
    expect(fingerprintRecallStateV2(s1)).not.toBe(fingerprintRecallStateV2(s3))
  })
})

describe('isCandidateCorrectedOrReplaced', () => {
  it('is true when a flag is present, top-level or in metadata', () => {
    expect(isCandidateCorrectedOrReplaced({ flag: 'SUPERSEDED' })).toBe(true)
    expect(isCandidateCorrectedOrReplaced({ metadata: { flag: 'RETRACTED' } })).toBe(true)
  })

  it('is true when superseded_by is present, top-level or in metadata', () => {
    expect(isCandidateCorrectedOrReplaced({ superseded_by: 'newer-id' })).toBe(true)
    expect(isCandidateCorrectedOrReplaced({ metadata: { superseded_by: 'newer-id' } })).toBe(true)
  })

  it('is false for a plain current entry', () => {
    expect(isCandidateCorrectedOrReplaced({ content: 'c' })).toBe(false)
    expect(isCandidateCorrectedOrReplaced({ metadata: { subject: 'x' } })).toBe(false)
  })

  it('ignores an entry that merely replaces an older one (replaces, not replaced)', () => {
    // `metadata.supersedes` means THIS entry is the correction, not that it was corrected.
    expect(isCandidateCorrectedOrReplaced({ metadata: { supersedes: 'older-id' } })).toBe(false)
  })
})

describe('recallCandidateAgeBucket', () => {
  const now = new Date('2026-09-24T00:00:00Z')

  it('buckets this_week, this_month, older from stored_at alone — no comparison sent to Jev', () => {
    expect(recallCandidateAgeBucket({ timestamp: '2026-09-20T00:00:00Z' }, now)).toBe('this_week')
    expect(recallCandidateAgeBucket({ timestamp: '2026-09-01T00:00:00Z' }, now)).toBe('this_month')
    expect(recallCandidateAgeBucket({ timestamp: '2026-01-01T00:00:00Z' }, now)).toBe('older')
  })

  it('is unknown, not older, when there is no parseable timestamp', () => {
    expect(recallCandidateAgeBucket({}, now)).toBe('unknown')
    expect(recallCandidateAgeBucket({ timestamp: 'not-a-date' }, now)).toBe('unknown')
  })

  it('treats a future timestamp as current rather than aged', () => {
    expect(recallCandidateAgeBucket({ timestamp: '2026-09-25T00:00:00Z' }, now)).toBe('this_week')
  })

  it('is a boundary at exactly 7 and 30 days', () => {
    expect(recallCandidateAgeBucket({ timestamp: '2026-09-17T00:00:00Z' }, now)).toBe('this_week')
    expect(recallCandidateAgeBucket({ timestamp: '2026-08-25T00:00:00Z' }, now)).toBe('this_month')
  })
})
