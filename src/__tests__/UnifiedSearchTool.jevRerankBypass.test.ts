/**
 * Eval-only per-request bypass: `options.jevRerank === false`. Skips the served Jev
 * re-rank for THIS request and returns production order, even with KMS_JEV_RERANK=1
 * server-wide — for the offline labelling harness (`src/scripts/label-recall-pool.ts`)
 * only, never a normal caller option.
 *
 * Extends the `_rerankFlag` cache-separation technique in `UnifiedSearchTool.servedRerank.test.ts`:
 * a bypassed response must never be served (from cache) to a normal caller as if it were
 * production order under an off flag, or vice versa, and a bypassed request must never
 * spend Jev budget — served OR shadow.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'
import type { DecisionEngine, DecisionLogSink, DecisionResult, ShadowRunRecord } from '../decision/index.js'

const FLAGS = ['KMS_JEV_RERANK', 'KMS_JEV_SHADOW_RERANK', 'KMS_JEV_SHADOW_REORDER', 'KMS_JEV_SHADOW_TOPK', 'KMS_JEV_RERANK_DEADLINE_MS'] as const
const CREDENTIAL_ENV = ['ONECLI_TOKEN', 'ONECLI_GATEWAY', 'TYPESAFE_API_KEY'] as const
const QUERY = 'quarterly revenue forecast'

const entry = (id: string, content: string, over: Record<string, any> = {}) => ({
  id, content, contentType: 'fact', confidence: 1, timestamp: '2026-06-01T00:00:00.000Z', metadata: {}, ...over,
})

// Same fixture as UnifiedSearchTool.servedRerank.test.ts: production ranks `keyword`
// first; the engine (when consulted) disagrees and prefers `semantic`.
const GRAPH = [
  entry('keyword', 'the forecast meeting was rescheduled to Thursday'),
  entry('semantic', 'Q3 sales are projected at 4.2M'),
]

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

const memoryCache = () => {
  const store = new Map<string, any>()
  return {
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
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

describe('UnifiedSearchTool jevRerank eval-only bypass', () => {
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

  it('server flag OFF + bypass requested: production order, engine never consulted, _rerank absent', async () => {
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })
    const response = await tool.search({ query: QUERY, options: { jevRerank: false } })

    expect(evaluate).not.toHaveBeenCalled()
    expect(response.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
    expect(response._rerank).toBeUndefined()
  })

  it('server flag ON + bypass requested: production order served, engine never consulted, _rerank absent', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })
    const response = await tool.search({ query: QUERY, options: { jevRerank: false } })

    // The engine would have reordered to ['semantic', 'keyword'] had it been consulted.
    expect(evaluate).not.toHaveBeenCalled()
    expect(response.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
    expect(response._rerank).toBeUndefined()
  })

  it('server flag ON + bypass requested: does NOT also fire the shadow rerank (bypass must spend zero Jev budget)', async () => {
    process.env.KMS_JEV_RERANK = '1'
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    process.env.KMS_JEV_SHADOW_REORDER = '1'
    const { engine, evaluate } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })

    await tool.search({ query: QUERY, options: { jevRerank: false } })
    await tool.awaitShadowIdle()

    expect(evaluate).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0)
  })

  it('server flag OFF + bypass NOT requested: shadow rerank still fires as before (bypass does not disable shadow globally)', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    process.env.KMS_JEV_SHADOW_REORDER = '1'
    const { engine, evaluate } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })

    await tool.search({ query: QUERY }) // no options.jevRerank at all
    await tool.awaitShadowIdle()

    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(1)
  })

  it('omitting options.jevRerank, or passing true, has no effect: behaves exactly like today', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })

    const response = await tool.search({ query: QUERY, options: { jevRerank: true } })
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(response.results.map((r: any) => r.id)).toEqual(['semantic', 'keyword'])
    expect(response._rerank).toMatchObject({ applied: true })
  })

  it('cache: a bypassed response and a normal (non-bypassed) response for the SAME query never cross-serve each other', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const cache = memoryCache()
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null }, cache)

    const bypassed = await tool.search({ query: QUERY, options: { jevRerank: false } })
    expect(bypassed.results.map((r: any) => r.id)).toEqual(['keyword', 'semantic'])
    expect(evaluate).not.toHaveBeenCalled()

    const normal = await tool.search({ query: QUERY }) // no jevRerank option — a distinct cache key
    expect(normal.fromCache).toBe(false) // never a false hit off the bypassed entry
    expect(normal.results.map((r: any) => r.id)).toEqual(['semantic', 'keyword'])
    expect(evaluate).toHaveBeenCalledTimes(2)

    // Two distinct entries — the bypass option is part of what's cached under.
    expect(cache.store.size).toBe(2)
  })

  it('cache: the bypassed entry itself is served from cache on a second identical bypassed call, with no further engine use', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const cache = memoryCache()
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null }, cache)

    const first = await tool.search({ query: QUERY, options: { jevRerank: false } })
    const second = await tool.search({ query: QUERY, options: { jevRerank: false } })

    expect(evaluate).not.toHaveBeenCalled()
    expect(second.fromCache).toBe(true)
    expect(second.results.map((r: any) => r.id)).toEqual(first.results.map((r: any) => r.id))
    expect(second._rerank).toBeUndefined()
  })

  it('a cached bypassed entry carries no _rerankFlag (reads exactly like a production/flag-off entry)', async () => {
    process.env.KMS_JEV_RERANK = '1'
    const cache = memoryCache()
    const { engine } = opinionatedEngine()
    await buildTool({ engine, log: null }, cache).search({ query: QUERY, options: { jevRerank: false } })

    expect(cache.store.size).toBe(1)
    const [[, cached]] = Array.from(cache.store.entries())
    expect(cached._rerankFlag).toBeUndefined()
    expect(cached._rerank).toBeUndefined()
  })
})
