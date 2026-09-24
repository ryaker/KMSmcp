/**
 * Served Jev re-rank wired into UnifiedSearchTool.search().
 *
 * Gated on KMS_JEV_RERANK=1, default OFF (the owner flips it — see
 * `~/Documents/Notes/kms-jev-architecture-v2.md` §3A / §5 step 3). Unlike shadow rerank
 * (`UnifiedSearchTool.shadowRerank.test.ts`), the whole point here is that the response
 * DOES change when the flag is on: the caller receives the Jev order, not production's.
 * These tests pin: flag-off is untouched, flag-on reorders and never outlasts or fails
 * the search, duplicates are collapsed before judging, and the cache never crosses the
 * flag boundary in either direction.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'
import type { DecisionEngine, DecisionLogSink, DecisionResult, ShadowRunRecord } from '../decision/index.js'

const FLAGS = ['KMS_JEV_RERANK', 'KMS_JEV_SHADOW_RERANK', 'KMS_JEV_SHADOW_REORDER', 'KMS_JEV_SHADOW_TOPK', 'KMS_JEV_RERANK_DEADLINE_MS'] as const
const CREDENTIAL_ENV = ['ONECLI_TOKEN', 'ONECLI_GATEWAY', 'TYPESAFE_API_KEY'] as const
const QUERY = 'quarterly revenue forecast'

const entry = (id: string, content: string, over: Record<string, any> = {}) => ({
  id, content, contentType: 'fact', confidence: 1, timestamp: '2026-06-01T00:00:00.000Z', metadata: {}, ...over,
})

// Production ranks `keyword` first (it shares a query term; `semantic` shares none); the
// engine thinks `semantic` is the real answer — same fixture as the shadow-rerank tests,
// so a reader can compare the two contracts directly.
const GRAPH = [
  entry('keyword', 'the forecast meeting was rescheduled to Thursday'),
  entry('semantic', 'Q3 sales are projected at 4.2M'),
]

/** Scores by content: the inverse of production order. v2 questions — no `status` Choice. */
const opinionatedEngine = () => {
  const evaluate = jest.fn(async (request: any): Promise<DecisionResult> => {
    const isAnswer = String(request.state.candidate.content).includes('4.2M')
    return {
      provider: 'mock', model: 'mock-1', requestedModel: 'mock-latest',
      answers: {
        answers_query: { type: 'noul', probability: isAnswer ? 0.98 : 0.03 },
        evidence_value: { type: 'score', score: isAnswer ? 3.9 : 0.2, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.6 } },
        contradicts_premise: { type: 'noul', probability: 0 },
        contains_instruction: { type: 'noul', probability: 0 },
        describes_past_state: { type: 'noul', probability: 0 },
      },
      usage: { inputTokens: 300, outputTokens: 10 }, latencyMs: 20, costUsdEstimate: 0.0000126,
    }
  })
  const engine: DecisionEngine = { provider: 'mock', requestedModel: 'mock-latest', evaluate }
  return { engine, evaluate }
}

/** A minimal cache satisfying the two methods UnifiedSearchTool actually calls. */
const memoryCache = () => {
  const store = new Map<string, any>()
  return {
    get: jest.fn(async (key: string) => store.has(key) ? store.get(key) : null),
    set: jest.fn(async (key: string, value: any) => { store.set(key, value) }),
    store,
  } as any
}

const buildTool = (decision?: { engine?: DecisionEngine | null, log?: DecisionLogSink | null }, cache: any = null) => {
  const graph: any = {
    search: jest.fn().mockResolvedValue(GRAPH.map(e => ({ ...e }))),
    getEntitySummary: jest.fn().mockResolvedValue(null),
    getOperationalNodes: jest.fn().mockResolvedValue([]),
    findById: jest.fn(() => null),
  }
  const mem0 = { search: jest.fn().mockResolvedValue([]) }
  const mongodb = { search: jest.fn().mockResolvedValue([]) }
  return new UnifiedSearchTool({ mongodb, graph, mem0 } as any, cache, null, decision)
}

const memoryLog = () => {
  const rows: ShadowRunRecord[] = []
  const log: DecisionLogSink = { write: jest.fn(async r => { rows.push(r) }) }
  return { log, rows }
}

/** The response minus wall-clock fields, which differ between any two runs. */
const stable = (response: any) => {
  const { searchTime: _searchTime, performance: _performance, ...rest } = response
  if (rest._rerank) rest._rerank = { ...rest._rerank, latency_ms: undefined }
  return rest
}

describe('UnifiedSearchTool served rerank', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const name of [...FLAGS, ...CREDENTIAL_ENV]) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const name of [...FLAGS, ...CREDENTIAL_ENV]) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  it('is OFF by default: the engine is never consulted, no _rerank field, response unchanged', async () => {
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })
    const response = await tool.search({ query: QUERY })

    expect(evaluate).not.toHaveBeenCalled()
    expect(response.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
    expect(response._rerank).toBeUndefined()
  })

  it('flag off gives byte-identical results to today: same response whether or not an engine is wired up', async () => {
    const baseline = await buildTool().search({ query: QUERY })

    const { engine } = opinionatedEngine()
    const withUnusedEngine = await buildTool({ engine, log: null }).search({ query: QUERY })

    expect(stable(withUnusedEngine)).toEqual(stable(baseline))
    expect(JSON.stringify(withUnusedEngine)).not.toMatch(/_rerank/)
  })

  it.each(['0', 'true', 'on', ''])('stays OFF for KMS_JEV_RERANK=%p', async value => {
    process.env.KMS_JEV_RERANK = value
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })
    await tool.search({ query: QUERY })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('when ON, awaits the engine and reorders by score, with _rerank.applied = true', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const { engine, evaluate } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })

    const response = await tool.search({ query: QUERY })

    expect(evaluate).toHaveBeenCalledTimes(2)
    // The engine disagreed with production, and the caller received ITS order.
    expect(response.results.map((r: any) => r.id)).toEqual(['semantic', 'keyword'])
    expect(response._rerank).toMatchObject({ applied: true, judged: 2, collapsed: 0 })
    expect(response._rerank.reason).toBeUndefined()
    expect(typeof response._rerank.latency_ms).toBe('number')
    // Logged as served, not shadow.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ served: true, policy_decision: 'shadow_reorder', query: QUERY })
  })

  it('honours the protection rule: a strong lexical match is never demoted', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const { engine } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })
    // Every query term present → _relevance is high → protected, however the engine scores it.
    ;(tool as any).storage.graph.search.mockResolvedValue([
      entry('keyword', 'quarterly revenue forecast meeting was rescheduled'),
      entry('semantic', 'Q3 sales are projected at 4.2M'),
    ])
    const response = await tool.search({ query: QUERY })
    expect(response.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
  })

  it('with no credential route (no_engine): serves production order, _rerank.reason = "no_engine", never throws', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const warn = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const tool = buildTool() // nothing injected → resolves from the (emptied) environment
      const response = await tool.search({ query: QUERY })
      expect(response.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
      expect(response._rerank).toMatchObject({ applied: false, reason: 'no_engine', judged: 0 })
    } finally {
      warn.mockRestore()
    }
  })

  it('on a deadline miss: serves production order, _rerank.reason = "deadline", and is never slower than the deadline plus fault handling', async () => {
    jest.useFakeTimers()
    try {
      process.env.KMS_JEV_RERANK = '1'
      process.env.KMS_JEV_RERANK_DEADLINE_MS = '50'
      const evaluate = jest.fn((): Promise<DecisionResult> => new Promise(() => { /* never settles */ }))
      const tool = buildTool({ engine: { provider: 'mock', requestedModel: 'm', evaluate }, log: null })

      const pending = tool.search({ query: QUERY })
      await jest.advanceTimersByTimeAsync(50)
      const response = await pending

      expect(response.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
      expect(response._rerank).toMatchObject({ applied: false, reason: 'deadline' })
    } finally {
      jest.useRealTimers()
    }
  })

  it('a throwing engine cannot fail the search: production order served, nothing judged', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const evaluate = jest.fn().mockRejectedValue(new Error('401 Unauthorized'))
    const tool = buildTool({ engine: { provider: 'mock', requestedModel: 'm', evaluate }, log: null })

    const response = await tool.search({ query: QUERY })
    expect(response.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
    expect(response._rerank?.judged).toBe(0)
  })

  it('collapses a mem0 shard against its graph parent before judging, and reports the count', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const { engine, evaluate } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })
    ;(tool as any).storage.mem0.search.mockResolvedValue([
      { id: 'shard-1', content: 'User described that Q3 sales are projected at 4.2M', metadata: { kms_id: 'semantic' }, confidence: 0.7 },
    ])

    const response = await tool.search({ query: QUERY })

    // 3 candidates reached search (keyword, semantic, shard-1), but only 2 were judged —
    // the shard was collapsed into its parent before any engine call.
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(response._rerank).toMatchObject({ collapsed: 1 })
    expect(rows[0].collapsed_duplicates).toBe(1)
  })

  it('does not ALSO fire the shadow run when served rerank is on', async () => {
    process.env.KMS_JEV_RERANK = '1'
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    process.env.KMS_JEV_SHADOW_REORDER = '1'
    const { engine, evaluate } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })

    await tool.search({ query: QUERY })
    await tool.awaitShadowIdle()

    // One request per candidate for the SERVED run only — a second (shadow) run over the
    // same pool would double this to 4.
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(1)
    expect(rows[0].served).toBe(true)
  })

  it('cache: a response cached with the flag OFF is not served as reranked when the flag turns ON', async () => {
    const cache = memoryCache()
    await buildTool(undefined, cache).search({ query: QUERY })
    expect(cache.store.size).toBe(1)

    process.env.KMS_JEV_RERANK = '1'
    const { engine, evaluate } = opinionatedEngine()
    const response = await buildTool({ engine, log: null }, cache).search({ query: QUERY })

    // A hit under the old (flag-off) entry would never have called the engine.
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(response.fromCache).toBe(false)
    expect(response.results.map((r: any) => r.id)).toEqual(['semantic', 'keyword'])
  })

  it('cache: a response cached with the flag ON is not served production-order when the flag turns OFF', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const cache = memoryCache()
    const { engine } = opinionatedEngine()
    const reranked = await buildTool({ engine, log: null }, cache).search({ query: QUERY })
    expect(reranked.results.map((r: any) => r.id)).toEqual(['semantic', 'keyword'])

    delete process.env.KMS_JEV_RERANK
    const { evaluate: unusedEvaluate } = opinionatedEngine()
    const response = await buildTool(undefined, cache).search({ query: QUERY })

    expect(unusedEvaluate).not.toHaveBeenCalled()
    expect(response.fromCache).toBe(false)
    expect(response.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
    expect(response._rerank).toBeUndefined()
  })

  it('cache: a second search under the SAME flag state (ON) is served from cache without re-consulting the engine', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const cache = memoryCache()
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null }, cache)

    const first = await tool.search({ query: QUERY })
    const second = await tool.search({ query: QUERY })

    expect(evaluate).toHaveBeenCalledTimes(2) // only the first search consulted the engine
    expect(second.fromCache).toBe(true)
    expect(second.results.map((r: any) => r.id)).toEqual(first.results.map((r: any) => r.id))
    expect(second._rerank).toEqual(first._rerank)
  })
})
