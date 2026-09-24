/**
 * `runServedRerank()` against a mocked DecisionEngine — the served counterpart of
 * `decision-shadowRerank.test.ts`. What's new relative to shadow: the engine is
 * AWAITED and its ordering is what a caller gets back, Mem0 shard duplicates are
 * collapsed before judging, and every non-clean exit (deadline, no engine, a fault)
 * must return `ranked` completely unchanged.
 */

import {
  JEV_SERVED_RERANK_FLAG,
  collapseMem0Duplicates,
  isJevServedRerankEnabled,
  runServedRerank,
} from '../decision/servedRerank.js'
import { TokenBucket, setEngineRateLimiterForTests } from '../decision/engineSlot.js'
import { EVIDENCE_VALUE_LEVELS } from '../decision/recallEvidence.js'
import type { DecisionLogSink, ShadowRunRecord } from '../decision/decisionLog.js'
import type { DecisionEngine, DecisionRequest, DecisionResult } from '../decision/types.js'

const NOW = new Date('2026-09-24T12:00:00.000Z')
const QUERY = 'how many cameras does Phoenix use'

/** v2 verdict: the five nouls/score `evaluateRecallCandidates` now asks. Unset flags
 *  default to 0 — RANKED's fixtures only set what each test needs. */
interface Verdict { answers: number; evidence: number; instruction?: number; pastState?: number; contradicts?: number }

/** An engine whose verdict is looked up from the candidate content it is shown. */
const mockEngine = (verdicts: Record<string, Verdict | Error>) => {
  const evaluate = jest.fn(async (request: DecisionRequest): Promise<DecisionResult> => {
    const content = (request.state as any).candidate.content as string
    const verdict = verdicts[content]
    if (verdict instanceof Error) throw verdict
    if (!verdict) throw new Error(`no verdict for "${content}"`)
    const level = Math.round(verdict.evidence)
    return {
      provider: 'mock',
      model: 'mock-1.0.0',
      requestedModel: 'mock-latest',
      answers: {
        answers_query: { type: 'noul', probability: verdict.answers },
        evidence_value: {
          type: 'score',
          score: verdict.evidence,
          probabilities: Object.fromEntries(EVIDENCE_VALUE_LEVELS.map((_, i) => [String(i), i === level ? 1 : 0])),
          confidence: 0.7,
        },
        contradicts_premise: { type: 'noul', probability: verdict.contradicts ?? 0 },
        contains_instruction: { type: 'noul', probability: verdict.instruction ?? 0 },
        describes_past_state: { type: 'noul', probability: verdict.pastState ?? 0 },
      },
      usage: { inputTokens: 400, outputTokens: 12 },
      latencyMs: 35,
      costUsdEstimate: 0.0000168,
      requestId: `req-${content}`,
    }
  })
  const engine: DecisionEngine = { provider: 'mock', requestedModel: 'mock-latest', evaluate }
  return { engine, evaluate }
}

const memorySink = () => {
  const rows: ShadowRunRecord[] = []
  const sink: DecisionLogSink = { write: jest.fn(async r => { rows.push(r) }) }
  return { sink, rows }
}

const RANKED = [
  { id: 'noise', content: 'phoenix session notes', _relevance: 0.6, confidence: 1, sourceSystem: 'graph' },
  // `flag: 'SUPERSEDED'` exercises the code-known correction multiplier (0.5x) that
  // replaced v1's `superseded_context` status.
  { id: 'old', content: 'phoenix had 6 cameras', _relevance: 0.5, confidence: 1, sourceSystem: 'graph', metadata: { flag: 'SUPERSEDED' } },
  { id: 'answer', content: 'phoenix uses 16 cameras', _relevance: 0.4, confidence: 0.6, sourceSystem: 'vector' },
]

const VERDICTS: Record<string, Verdict> = {
  'phoenix session notes': { answers: 0.05, evidence: 1 },
  'phoenix had 6 cameras': { answers: 0.7, evidence: 3 },
  'phoenix uses 16 cameras': { answers: 0.97, evidence: 4 },
}

const unthrottled = () => new TokenBucket({ ratePerSecond: 1e6, burst: 1e6, maxQueue: 1e6 })
beforeEach(() => setEngineRateLimiterForTests(unthrottled()))
afterEach(() => setEngineRateLimiterForTests())

describe('flags', () => {
  it('is OFF unless the flag is exactly "1"', () => {
    expect(JEV_SERVED_RERANK_FLAG).toBe('KMS_JEV_RERANK')
    expect(isJevServedRerankEnabled({})).toBe(false)
    expect(isJevServedRerankEnabled({ KMS_JEV_RERANK: '0' })).toBe(false)
    expect(isJevServedRerankEnabled({ KMS_JEV_RERANK: 'true' })).toBe(false)
    expect(isJevServedRerankEnabled({ KMS_JEV_RERANK: '1' })).toBe(true)
  })
})

describe('collapseMem0Duplicates', () => {
  it('drops a mem0 shard whose parent id is also a candidate, keeping the parent', () => {
    const pool = [
      { id: 'parent-1', content: 'the full entry' },
      { id: 'shard-a', content: 'User described the full entry', metadata: { kms_id: 'parent-1' } },
      { id: 'other', content: 'unrelated' },
    ]
    const { collapsed, count } = collapseMem0Duplicates(pool)
    expect(count).toBe(1)
    expect(collapsed.map(c => c.id)).toEqual(['parent-1', 'other'])
  })

  it('reads camelCased kmsId too (mem0ai v3 read shape)', () => {
    const pool = [
      { id: 'parent-1', content: 'the full entry' },
      { id: 'shard-a', content: 'shard', metadata: { kmsId: 'parent-1' } },
    ]
    expect(collapseMem0Duplicates(pool).count).toBe(1)
  })

  it('leaves a shard alone when its parent is not in the pool', () => {
    const pool = [{ id: 'shard-a', content: 'shard', metadata: { kms_id: 'not-here' } }]
    const { collapsed, count } = collapseMem0Duplicates(pool)
    expect(count).toBe(0)
    expect(collapsed).toHaveLength(1)
  })

  it('drops two shards of the same parent, keeping the parent exactly once', () => {
    const pool = [
      { id: 'shard-a', content: 'a', metadata: { kms_id: 'parent-1' } },
      { id: 'parent-1', content: 'the full entry' },
      { id: 'shard-b', content: 'b', metadata: { kms_id: 'parent-1' } },
    ]
    const { collapsed, count } = collapseMem0Duplicates(pool)
    expect(count).toBe(2)
    expect(collapsed.map(c => c.id)).toEqual(['parent-1'])
  })

  it('preserves order of the survivors and never mutates the input', () => {
    const pool = [...RANKED]
    const snapshot = JSON.stringify(pool)
    const { collapsed } = collapseMem0Duplicates(pool)
    expect(collapsed.map(c => c.id)).toEqual(['noise', 'old', 'answer'])
    expect(JSON.stringify(pool)).toBe(snapshot)
  })
})

describe('runServedRerank', () => {
  it('reorders by score when it gets a clean answer within the deadline', async () => {
    const { engine, evaluate } = mockEngine(VERDICTS)
    const run = await runServedRerank({ engine, query: QUERY, ranked: RANKED, now: NOW })

    expect(evaluate).toHaveBeenCalledTimes(3)
    expect(run.meta).toMatchObject({ applied: true, judged: 3, collapsed: 0 })
    expect(run.meta.reason).toBeUndefined()
    expect(typeof run.meta.latency_ms).toBe('number')
    expect(run.ordered.map((c: any) => c.id)).toEqual(['answer', 'old', 'noise'])
  })

  it('never mutates the ranked input', async () => {
    const { engine } = mockEngine(VERDICTS)
    const ranked = RANKED.map(c => ({ ...c }))
    const snapshot = JSON.stringify(ranked)
    await runServedRerank({ engine, query: QUERY, ranked, now: NOW })
    expect(JSON.stringify(ranked)).toBe(snapshot)
  })

  it('honours the protection rule: a strong lexical match is never demoted', async () => {
    const ranked = [
      { id: 'keyword', content: 'quarterly revenue forecast meeting was rescheduled', _relevance: 0.95 },
      { id: 'semantic', content: 'Q3 sales are projected at 4.2M', _relevance: 0.2 },
    ]
    const { engine } = mockEngine({
      'quarterly revenue forecast meeting was rescheduled': { answers: 0.03, evidence: 0 },
      'Q3 sales are projected at 4.2M': { answers: 0.98, evidence: 4 },
    })
    const run = await runServedRerank({ engine, query: 'quarterly revenue forecast', ranked, now: NOW })

    // The engine strongly prefers `semantic`, but `keyword` is a protected lexical match
    // (>= PROTECT_LEXICAL_RELEVANCE_MIN) and must not be demoted below its production rank.
    expect(run.ordered.map((c: any) => c.id)).toEqual(['keyword', 'semantic'])
  })

  it('collapses a mem0 shard against its in-pool parent before judging, and reports the count', async () => {
    const pool = [
      { id: 'shard-a', content: 'User described that phoenix uses 16 cameras', metadata: { kms_id: 'answer' }, _relevance: 0.4 },
      ...RANKED,
    ]
    const { engine, evaluate } = mockEngine(VERDICTS)
    const run = await runServedRerank({ engine, query: QUERY, ranked: pool, now: NOW })

    // Only the 3 parent-bearing candidates were judged — the shard never reached the engine.
    expect(evaluate).toHaveBeenCalledTimes(3)
    expect(evaluate.mock.calls.some(([req]) => (req as any).state.candidate.content.startsWith('User described'))).toBe(false)
    expect(run.meta.collapsed).toBe(1)
    expect(run.ordered.map((c: any) => c.id)).toEqual(['answer', 'old', 'noise'])
    expect(run.runRecord?.collapsed_duplicates).toBe(1)
  })

  it('serves production order unchanged when there is no engine (no_engine)', async () => {
    const run = await runServedRerank({ engine: null, query: QUERY, ranked: RANKED, now: NOW })
    expect(run.meta).toEqual({ applied: false, reason: 'no_engine', latency_ms: 0, judged: 0, collapsed: 0 })
    expect(run.ordered).toBe(RANKED)
    expect(run.runRecord).toBeNull()
  })

  it('serves production order unchanged when disabled', async () => {
    const { engine, evaluate } = mockEngine(VERDICTS)
    const run = await runServedRerank({ engine, query: QUERY, ranked: RANKED, now: NOW, enabled: false })
    expect(evaluate).not.toHaveBeenCalled()
    expect(run.meta).toEqual({ applied: false, reason: 'disabled', latency_ms: 0, judged: 0, collapsed: 0 })
    expect(run.ordered).toBe(RANKED)
    expect(run.runRecord).toBeNull()
  })

  it('serves production order unchanged, and never fails, when the engine always throws', async () => {
    const evaluate = jest.fn().mockRejectedValue(new Error('401 Unauthorized'))
    const engine: DecisionEngine = { provider: 'mock', requestedModel: 'm', evaluate }
    const run = await runServedRerank({ engine, query: QUERY, ranked: RANKED, now: NOW })

    // Per-candidate failures are caught inside evaluateRecallCandidates and logged as
    // error rows, not thrown — so this run completes cleanly (not a deadline/no_engine
    // fallback) but nothing was judged, and the order is unchanged either way.
    expect(run.meta.judged).toBe(0)
    expect(run.ordered.map((c: any) => c.id)).toEqual(['noise', 'old', 'answer'])
  })

  it('serves production order unchanged and reports reason "error" if evaluation itself throws', async () => {
    // A pool whose iteration blows up before any per-candidate try/catch can run —
    // simulates "a bug", the one case evaluateRecallCandidates cannot itself absorb.
    const engine: DecisionEngine = {
      provider: 'mock', requestedModel: 'm',
      evaluate: jest.fn(),
    }
    const poisoned: any[] = RANKED.map(c => ({ ...c }))
    Object.defineProperty(poisoned, 'slice', { value: () => { throw new Error('boom') } })
    const run = await runServedRerank({ engine, query: QUERY, ranked: poisoned, now: NOW })
    expect(run.meta).toMatchObject({ applied: false, reason: 'error', judged: 0 })
    expect(run.ordered).toBe(poisoned)
    expect(run.runRecord).toBeNull()
  })

  // Helper: an engine where the candidate with `hangContent` never answers until aborted.
  const hangingEngine = (hangContent: string): DecisionEngine => ({
    provider: 'mock', requestedModel: 'm',
    evaluate: jest.fn((request: DecisionRequest): Promise<DecisionResult> => {
      const content = (request.state as any).candidate.content as string
      if (content !== hangContent) return mockEngine(VERDICTS).engine.evaluate(request)
      return new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    }),
  })

  it('a deadline hit with some judgments still serves the policy order; the late candidate keeps its production slot', async () => {
    jest.useFakeTimers()
    try {
      const { sink, rows } = memorySink()
      // 'answer' (production #3) misses the deadline; 'old' and 'noise' are judged.
      const pending = runServedRerank({ engine: hangingEngine('phoenix uses 16 cameras'), query: QUERY, ranked: RANKED, now: NOW, deadlineMs: 300, sink })
      await jest.advanceTimersByTimeAsync(300)
      const run = await pending

      expect(run.meta).toMatchObject({ applied: true, partial: true, judged: 2, unjudged: 1 })
      expect(run.meta.reason).toBeUndefined()
      expect(run.ordered.map((c: any) => c.id)).toEqual(['old', 'noise', 'answer'])
      expect(rows).toHaveLength(1)
      expect(rows[0].served).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('an unjudged candidate is never demoted below its production position', async () => {
    jest.useFakeTimers()
    try {
      // 'noise' (production #1) misses the deadline: it must stay first even though it
      // would score lowest; the judged pair is re-ranked behind it.
      const pending = runServedRerank({ engine: hangingEngine('phoenix session notes'), query: QUERY, ranked: RANKED, now: NOW, deadlineMs: 300 })
      await jest.advanceTimersByTimeAsync(300)
      const run = await pending

      expect(run.meta).toMatchObject({ applied: true, partial: true, judged: 2, unjudged: 1 })
      expect(run.ordered.map((c: any) => c.id)).toEqual(['noise', 'answer', 'old'])
    } finally {
      jest.useRealTimers()
    }
  })

  it('logs a served run with served: true and the same row shape as a shadow run', async () => {
    const { engine } = mockEngine(VERDICTS)
    const { sink, rows } = memorySink()
    await runServedRerank({ engine, query: QUERY, ranked: RANKED, now: NOW, sink })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'recall_shadow_run',
      served: true,
      policy_decision: 'shadow_reorder',
      query: QUERY,
      candidates_in_pool: 3,
      candidates_evaluated: 3,
      candidates_failed: 0,
      collapsed_duplicates: 0,
      production_order: ['noise', 'old', 'answer'],
      shadow_order: ['answer', 'old', 'noise'],
    })
  })

  it('respects topK: candidates beyond it are never judged and keep production order after the reranked block', async () => {
    const { engine, evaluate } = mockEngine(VERDICTS)
    const tailItem = { id: 'tail', content: 'irrelevant tail item', _relevance: 0.1 }
    const run = await runServedRerank({ engine, query: QUERY, ranked: [...RANKED, tailItem], now: NOW, topK: 3 })

    expect(evaluate).toHaveBeenCalledTimes(3)
    expect(run.ordered.map((c: any) => c.id)).toEqual(['answer', 'old', 'noise', 'tail'])
  })

  it('survives a log sink that throws', async () => {
    const { engine } = mockEngine(VERDICTS)
    const sink: DecisionLogSink = { write: jest.fn().mockRejectedValue(new Error('disk full')) }
    await expect(runServedRerank({ engine, query: QUERY, ranked: RANKED, now: NOW, sink }))
      .resolves.toMatchObject({ meta: { applied: true } })
  })

  it('handles an empty pool without calling the engine', async () => {
    const { engine, evaluate } = mockEngine({})
    const run = await runServedRerank({ engine, query: QUERY, ranked: [], now: NOW })
    expect(evaluate).not.toHaveBeenCalled()
    expect(run.meta).toMatchObject({ applied: true, judged: 0, collapsed: 0 })
    expect(run.ordered).toEqual([])
  })
})
