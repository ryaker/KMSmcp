/**
 * Ranking tests for UnifiedSearchTool.
 *
 * These pin the behaviour that was broken before: `confidence` (always 1 on stored
 * entries) was the primary sort key, so it never discriminated, and the fallback
 * relevance function matched substrings — ranking an insurance doc about a "session
 * timeout" alongside an exact match for an Ollama timeout query.
 *
 * rankResults/calculateRelevance/calculateRecency are private; they are reached via
 * bracket access rather than being made public purely for testability.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'

// The constructor takes wired-up storage systems; ranking is pure and touches none of
// them, so an empty object is sufficient to exercise it.
const tool = new UnifiedSearchTool({} as any, {} as any)
const rank = (results: any[], query: string) => (tool as any).rankResults(results, query)
const relevance = (content: string, query: string) => (tool as any).calculateRelevance(content, query)
const recency = (ts?: string) => (tool as any).calculateRecency(ts)

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

describe('UnifiedSearchTool ranking', () => {
  describe('calculateRelevance', () => {
    it('scores an on-topic result above a coincidental word match', () => {
      const query = 'Ollama timeout classification routing KMS'
      const onTopic = relevance(
        'KMS Ollama classification routing timeout: the classify budget was 3000ms and the Ollama probe timed out.',
        query,
      )
      const coincidental = relevance(
        'WinFlex session timeout is NOT a logout — it is a redirect to wfw_home.aspx while still logged in.',
        query,
      )
      expect(onTopic).toBeGreaterThan(coincidental)
      // And the coincidental hit should be weak in absolute terms, not merely lower.
      expect(coincidental).toBeLessThan(0.4)
    })

    it('matches on word boundaries, not substrings — suffix form', () => {
      // "out" must not match inside "timeout"; the old includes() check did.
      expect(relevance('the request timed out after a timeout', 'out')).toBeGreaterThan(0)
      expect(relevance('timeoutvalue configured', 'value')).toBe(0)
    })

    it('matches on word boundaries, not substrings — PREFIX form', () => {
      // A leading \b alone is not enough: "timeout" would still prefix-match
      // "timeoutvalue". Both ends must be bounded.
      expect(relevance('timeoutvalue configured', 'timeout')).toBe(0)
      expect(relevance('routerConfig loaded', 'route')).toBe(0)
    })

    it('still matches simple inflections, so bounding does not cost recall', () => {
      // Bounding both ends must not make the matcher brittle: plurals and common
      // verb forms are the same term for ranking purposes.
      expect(relevance('several timeouts were logged', 'timeout')).toBeGreaterThan(0)
      expect(relevance('routing the request', 'route')).toBeGreaterThan(0)
      expect(relevance('the probe timed out and aborted', 'abort')).toBeGreaterThan(0)
    })

    it('applies the phrase bonus once, not once per term', () => {
      // The old implementation added the exact-match bonus inside the per-term loop,
      // so a 5-term query that matched got 5x the intended bonus.
      const score = relevance('exact phrase here', 'exact phrase here')
      expect(score).toBeLessThanOrEqual(1)
    })

    it('is bounded to [0, 1] even on heavy repetition', () => {
      const spam = 'ollama '.repeat(500)
      const score = relevance(spam, 'ollama')
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(1)
    })

    it('ignores stopwords so filler does not inflate coverage', () => {
      // "the/of/a" appear in nearly any document; only "quasar" should count.
      expect(relevance('the story of a dog', 'the quasar of a dog')).toBeLessThan(1)
    })

    it('returns 0 for empty inputs', () => {
      expect(relevance('', 'query')).toBe(0)
      expect(relevance('content', '')).toBe(0)
    })
  })

  describe('calculateRecency', () => {
    it('decays with a 90-day half-life', () => {
      expect(recency(daysAgo(0))).toBeCloseTo(1, 1)
      expect(recency(daysAgo(90))).toBeCloseTo(0.5, 1)
      expect(recency(daysAgo(180))).toBeCloseTo(0.25, 1)
    })

    it('treats unknown or unparseable timestamps as neutral, not stale', () => {
      expect(recency(undefined)).toBe(0.5)
      expect(recency('not-a-date')).toBe(0.5)
    })
  })

  describe('rankResults', () => {
    it('does not let uniform confidence flatten the ranking', () => {
      // Every stored entry has confidence 1. Ranking must still discriminate.
      const results = [
        { content: 'WinFlex session timeout redirect behaviour', confidence: 1, timestamp: daysAgo(120) },
        { content: 'Ollama classify timeout raised from 3000ms to 8000ms', confidence: 1, timestamp: daysAgo(1) },
      ]
      const ranked = rank(results, 'Ollama classify timeout')
      expect(ranked[0].content).toContain('Ollama')
      expect(ranked[0]._score).toBeGreaterThan(ranked[1]._score)
    })

    it('prefers the newer entry when relevance is comparable', () => {
      const results = [
        { content: 'Ollama timeout fix applied', confidence: 1, timestamp: daysAgo(200) },
        { content: 'Ollama timeout fix applied', confidence: 1, timestamp: daysAgo(1) },
      ]
      const ranked = rank(results, 'Ollama timeout fix')
      expect(ranked[0].timestamp).toBe(results[1].timestamp)
    })

    it('does not let recency outrank a far more relevant older entry', () => {
      // Recency is a tie-breaker, not a trump card.
      const results = [
        { content: 'unrelated note about jewellery auctions', confidence: 1, timestamp: daysAgo(0) },
        { content: 'Ollama classify timeout budget raised; probe widened; classification restored', confidence: 1, timestamp: daysAgo(300) },
      ]
      const ranked = rank(results, 'Ollama classify timeout budget')
      expect(ranked[0].content).toContain('Ollama')
    })

    it('attaches an inspectable score breakdown to every result', () => {
      const ranked = rank([{ content: 'Ollama timeout', confidence: 1, timestamp: daysAgo(5) }], 'Ollama')
      expect(ranked[0]).toHaveProperty('_score')
      expect(ranked[0]).toHaveProperty('_relevance')
      expect(ranked[0]).toHaveProperty('_recency')
    })

    it('handles an empty result set', () => {
      expect(rank([], 'anything')).toEqual([])
    })
  })
})

describe('UnifiedSearchTool length normalisation', () => {
  const relevance = (content: string, query: string) => (tool as any).calculateRelevance(content, query)
  const rank = (results: any[], query: string) => (tool as any).rankResults(results, query)
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

  it('does not penalise a short, precisely on-topic entry', () => {
    const short = 'Ollama classify timeout raised to 8000ms.'
    expect(relevance(short, 'Ollama classify timeout')).toBeGreaterThan(0.8)
  })

  it('damps a long multi-topic note that merely mentions the terms', () => {
    // The "everything I did today" shape: one incidental mention buried in 3k chars.
    const megaNote = 'Session log. ' + 'Unrelated work on invoices and scheduling. '.repeat(60) +
      'Also touched Ollama classify timeout. ' + 'More unrelated notes about branding. '.repeat(20)
    const short = 'Ollama classify timeout raised to 8000ms.'
    expect(relevance(megaNote, 'Ollama classify timeout')).toBeLessThan(relevance(short, 'Ollama classify timeout'))
  })

  it('a short older exact match outranks a long same-day note — the baseline failure', () => {
    // Previously the mega-note won on recency alone despite being off-topic.
    const megaNote = {
      content: 'Session log. ' + 'Assorted unrelated work across many projects. '.repeat(70) +
               'Ollama classify timeout mentioned once. ',
      confidence: 1, timestamp: daysAgo(0),
    }
    const precise = {
      content: 'Ollama classify timeout raised from 3000ms to 8000ms.',
      confidence: 1, timestamp: daysAgo(45),
    }
    const ranked = rank([megaNote, precise], 'Ollama classify timeout')
    expect(ranked[0].content).toContain('raised from 3000ms')
  })

  it('damping is bounded — a long but genuinely on-topic entry is not buried', () => {
    const longOnTopic = 'Ollama classify timeout. '.repeat(150)
    expect(relevance(longOnTopic, 'Ollama classify timeout')).toBeGreaterThan(0.55)
  })
})
