/**
 * Tests for "recall beyond the re-rank window" (`../eval/recallWindow.ts`) — where the
 * first grade-2 candidate sits in production order relative to the current re-rank window.
 */
import {
  buildRecallWindowReport,
  classifyRecallWindow,
  sliceRecallWindowQueries,
  summarizeRecallWindow,
  type RecallWindowCandidate,
  type RecallWindowQuery,
} from '../eval/recallWindow.js'

const cand = (id: string, prod_rank: number, grade: number | null): RecallWindowCandidate => ({ id, prod_rank, grade })

const query = (candidates: RecallWindowCandidate[], source: RecallWindowQuery['source'] = 'eng', kind: RecallWindowQuery['kind'] = 'human'): RecallWindowQuery => ({
  source,
  kind,
  candidates,
})

// ── classifyRecallWindow ──────────────────────────────────────────────────────

describe('classifyRecallWindow', () => {
  it('is in_window when the first grade-2 candidate is within windowSize', () => {
    const q = query([cand('a', 1, 0), cand('b', 5, 2), cand('c', 30, 2)])
    const r = classifyRecallWindow(q, 20, 50)
    expect(r.firstGrade2Rank).toBe(5)
    expect(r.bucket).toBe('in_window')
  })

  it('is beyond_window when the first grade-2 candidate is past windowSize but within maxRank', () => {
    const q = query([cand('a', 1, 0), cand('b', 21, 2), cand('c', 45, 2)])
    const r = classifyRecallWindow(q, 20, 50)
    expect(r.firstGrade2Rank).toBe(21)
    expect(r.bucket).toBe('beyond_window')
  })

  it('is none_in_top when no candidate within maxRank has grade 2', () => {
    const q = query([cand('a', 1, 0), cand('b', 2, 1), cand('c', 50, 1)])
    const r = classifyRecallWindow(q, 20, 50)
    expect(r.firstGrade2Rank).toBeNull()
    expect(r.bucket).toBe('none_in_top')
  })

  it('ignores a grade-2 candidate beyond maxRank (would falsely count as found)', () => {
    const q = query([cand('a', 1, 0), cand('b', 51, 2)])
    const r = classifyRecallWindow(q, 20, 50)
    expect(r.firstGrade2Rank).toBeNull()
    expect(r.bucket).toBe('none_in_top')
  })

  it('picks the LOWEST rank among multiple grade-2 candidates, independent of input order', () => {
    const q = query([cand('c', 30, 2), cand('a', 5, 2), cand('b', 15, 2)])
    const r = classifyRecallWindow(q, 20, 50)
    expect(r.firstGrade2Rank).toBe(5)
  })

  it('a rank exactly at windowSize is in_window (boundary)', () => {
    const q = query([cand('a', 20, 2)])
    expect(classifyRecallWindow(q, 20, 50).bucket).toBe('in_window')
  })

  it('a rank exactly at windowSize + 1 is beyond_window (boundary)', () => {
    const q = query([cand('a', 21, 2)])
    expect(classifyRecallWindow(q, 20, 50).bucket).toBe('beyond_window')
  })

  it('treats a null grade (ungraded candidate) as not a grade-2 hit', () => {
    const q = query([cand('a', 1, null), cand('b', 2, null)])
    expect(classifyRecallWindow(q, 20, 50).bucket).toBe('none_in_top')
  })
})

// ── summarizeRecallWindow ─────────────────────────────────────────────────────

describe('summarizeRecallWindow', () => {
  it('computes shares over the three buckets', () => {
    const queries = [
      query([cand('a', 5, 2)]), // in_window
      query([cand('a', 25, 2)]), // beyond_window
      query([cand('a', 1, 0)]), // none_in_top
      query([cand('a', 3, 2)]), // in_window
    ]
    // give every query a candidate at rank 50 so none is excluded as "shallow"
    for (const q of queries) q.candidates = [...q.candidates, cand('z', 50, 0)]
    const s = summarizeRecallWindow('overall', queries, 20, 50)
    expect(s.n).toBe(4)
    expect(s.shareInWindow).toBe(0.5)
    expect(s.shareBeyondWindow).toBe(0.25)
    expect(s.shareNoneInTop).toBe(0.25)
    expect(s.excludedShallow).toBe(0)
  })

  it('excludes a query that was not fetched deep enough to see the full window (never inflates none_in_top by omission)', () => {
    const shallow = query([cand('a', 1, 0), cand('b', 10, 0)]) // max rank 10 < maxRank 50
    const full = query([cand('a', 5, 2), cand('z', 50, 0)])
    const s = summarizeRecallWindow('overall', [shallow, full], 20, 50)
    expect(s.n).toBe(1)
    expect(s.excludedShallow).toBe(1)
    expect(s.shareInWindow).toBe(1)
  })

  it('is all zeros for n=0, never NaN', () => {
    const s = summarizeRecallWindow('overall', [], 20, 50)
    expect(s.n).toBe(0)
    expect(s.shareInWindow).toBe(0)
    expect(s.shareBeyondWindow).toBe(0)
    expect(s.shareNoneInTop).toBe(0)
  })
})

// ── slicing + report ──────────────────────────────────────────────────────────

describe('sliceRecallWindowQueries', () => {
  it('slices by overall, source, and kind', () => {
    const queries = [query([cand('a', 50, 0)], 'eng', 'human'), query([cand('a', 50, 0)], 'personal', 'agent-payload')]
    const slices = sliceRecallWindowQueries(queries)
    expect(slices.overall).toHaveLength(2)
    expect(slices['source:eng']).toHaveLength(1)
    expect(slices['source:personal']).toHaveLength(1)
    expect(slices['kind:human']).toHaveLength(1)
    expect(slices['kind:agent-payload']).toHaveLength(1)
  })
})

describe('buildRecallWindowReport', () => {
  it('produces one summary per slice (overall + 2 sources + 2 kinds)', () => {
    const queries = [query([cand('a', 5, 2), cand('z', 50, 0)], 'eng', 'human')]
    const report = buildRecallWindowReport(queries, 20, 50)
    expect(report.map(r => r.slice).sort()).toEqual(['kind:agent-payload', 'kind:human', 'overall', 'source:eng', 'source:personal'].sort())
  })
})
