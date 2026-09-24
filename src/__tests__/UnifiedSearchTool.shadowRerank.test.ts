/**
 * Shadow recall rerank wired into UnifiedSearchTool.search().
 *
 * Gated on KMS_JEV_SHADOW_RERANK=1, default OFF. The contract these tests pin is the
 * word "shadow": with the flag on, the engine is consulted and a decision row is written,
 * and the response a caller receives is the same response it would have received with
 * the flag off — same results, same order, same scores, no new fields.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'
import type { DecisionEngine, DecisionLogSink, DecisionResult, ShadowRunRecord } from '../decision/index.js'

const FLAGS = ['KMS_JEV_SHADOW_RERANK', 'KMS_JEV_SHADOW_REORDER', 'KMS_JEV_SHADOW_TOPK'] as const
const CREDENTIAL_ENV = ['ONECLI_TOKEN', 'ONECLI_GATEWAY', 'TYPESAFE_API_KEY'] as const
const QUERY = 'quarterly revenue forecast'

const entry = (id: string, content: string, over: Record<string, any> = {}) => ({
  id, content, contentType: 'fact', confidence: 1, timestamp: '2026-06-01T00:00:00.000Z', metadata: {}, ...over,
})

// Production ranks `keyword` first (it shares a query term; `semantic` shares none); the
// engine thinks `semantic` is the real answer. A rerank that leaked would swap them.
// Only a PARTIAL term match, deliberately: a full one is a strong lexical match, which
// the policy pins in place — see the protected-match test below.
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

const buildTool = (decision?: { engine?: DecisionEngine | null, log?: DecisionLogSink | null }) => {
  const graph: any = {
    search: jest.fn().mockResolvedValue(GRAPH.map(e => ({ ...e }))),
    getEntitySummary: jest.fn().mockResolvedValue(null),
    getOperationalNodes: jest.fn().mockResolvedValue([]),
    findById: jest.fn(() => null),
  }
  const mem0 = { search: jest.fn().mockResolvedValue([]) }
  const mongodb = { search: jest.fn().mockResolvedValue([]) }
  return new UnifiedSearchTool({ mongodb, graph, mem0 } as any, null, null, decision)
}

const memoryLog = () => {
  const rows: ShadowRunRecord[] = []
  const log: DecisionLogSink = { write: jest.fn(async r => { rows.push(r) }) }
  return { log, rows }
}

/** The response minus wall-clock fields, which differ between any two runs. */
const stable = (response: any) => {
  const { searchTime: _searchTime, performance: _performance, ...rest } = response
  return rest
}

describe('UnifiedSearchTool shadow rerank', () => {
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

  it('is OFF by default: the engine is never consulted and nothing is logged', async () => {
    const { engine, evaluate } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })

    await tool.search({ query: QUERY })
    await tool.awaitShadowIdle()

    expect(evaluate).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it.each(['0', 'true', 'on', ''])('stays OFF for KMS_JEV_SHADOW_RERANK=%p', async value => {
    process.env.KMS_JEV_SHADOW_RERANK = value
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })
    await tool.search({ query: QUERY })
    await tool.awaitShadowIdle()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('when ON, evaluates the served ordering and logs a shadow_log row', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    const { engine, evaluate } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })

    const response = await tool.search({ query: QUERY })
    await tool.awaitShadowIdle()

    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ policy_decision: 'shadow_log', query: QUERY, shadow_order: null, candidates_evaluated: 2 })
    expect(rows[0].production_order).toEqual(response.results.map(r => r.id))
  })

  it('does NOT change the response — even when the shadow ordering disagrees with production', async () => {
    const baseline = await buildTool().search({ query: QUERY })
    expect(baseline.results.map(r => r.id)).toEqual(['keyword', 'semantic'])

    process.env.KMS_JEV_SHADOW_RERANK = '1'
    process.env.KMS_JEV_SHADOW_REORDER = '1'
    const { engine } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })
    const shadowed = await tool.search({ query: QUERY })
    await tool.awaitShadowIdle()

    // The engine really did disagree …
    expect(rows[0].candidates.map(c => c.policy_protected)).toEqual([null, null])
    expect(rows[0].policy_decision).toBe('shadow_reorder')
    expect(rows[0].shadow_order).toEqual(['semantic', 'keyword'])
    // … and the caller cannot tell.
    expect(stable(shadowed)).toEqual(stable(baseline))
    // Including after the run has finished: it holds no reference it could write through.
    expect(shadowed.results.map(r => r.id)).toEqual(['keyword', 'semantic'])
    expect(JSON.stringify(shadowed)).not.toMatch(/jev|shadow/i)
  })

  it('pins a strong lexical match in the shadow ordering, however the engine scores it', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    process.env.KMS_JEV_SHADOW_REORDER = '1'
    const { engine } = opinionatedEngine()
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine, log })
    // Every query term present → _relevance is high → protected.
    ;(tool as any).storage.graph.search.mockResolvedValue([
      entry('keyword', 'quarterly revenue forecast meeting was rescheduled'),
      entry('semantic', 'Q3 sales are projected at 4.2M'),
    ])
    await tool.search({ query: QUERY })
    await tool.awaitShadowIdle()

    expect(rows[0].candidates[0]).toMatchObject({ id: 'keyword', policy_protected: 'lexical_match' })
    // The engine scores `keyword` low (it isn't the "4.2M" content) — pinned anyway.
    expect(rows[0].candidates[0].jev!.answers_query).toEqual({ jev_probability: 0.03 })
    expect(rows[0].shadow_order).toEqual(['keyword', 'semantic'])
  })

  it('never writes an engine value into a result\'s confidence or score', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    process.env.KMS_JEV_SHADOW_REORDER = '1'
    const { engine } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })
    const response = await tool.search({ query: QUERY })
    await tool.awaitShadowIdle()

    for (const r of response.results) {
      expect(r.confidence).toBe(1)
      expect(Object.keys(r).filter(k => /jev|shadow/i.test(k))).toEqual([])
    }
  })

  it('does not wait for the engine — the search returns while evaluation is still in flight', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const evaluate = jest.fn(async () => { await gate; throw new Error('released') })
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine: { provider: 'mock', requestedModel: 'm', evaluate }, log })

    const response = await tool.search({ query: QUERY })
    expect(response.results).toHaveLength(2)
    expect(rows).toEqual([])

    release()
    await tool.awaitShadowIdle()
    expect(rows).toHaveLength(1)
    expect(rows[0].candidates_failed).toBe(2)
  })

  it('awaitShadowIdle waits for EVERY in-flight run, not just the latest', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const evaluate = jest.fn(async () => { await gate; throw new Error('released') })
    const { log, rows } = memoryLog()
    const tool = buildTool({ engine: { provider: 'mock', requestedModel: 'm', evaluate }, log })

    await tool.search({ query: QUERY })
    await tool.search({ query: `${QUERY} again` })
    let idle = false
    const waiting = tool.awaitShadowIdle().then(() => { idle = true })
    await new Promise(r => setTimeout(r, 10))
    expect(idle).toBe(false)

    release()
    await waiting
    expect(rows.map(r => r.query).sort()).toEqual([QUERY, `${QUERY} again`].sort())
  })

  it('a failing engine cannot fail the search', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    const evaluate = jest.fn().mockRejectedValue(new Error('401 Unauthorized'))
    const tool = buildTool({ engine: { provider: 'mock', requestedModel: 'm', evaluate }, log: null })

    const response = await tool.search({ query: QUERY })
    await expect(tool.awaitShadowIdle()).resolves.toBeUndefined()
    expect(response.results.map(r => r.id)).toEqual(['keyword', 'semantic'])
  })

  it('respects KMS_JEV_SHADOW_TOPK', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    process.env.KMS_JEV_SHADOW_TOPK = '1'
    const { engine, evaluate } = opinionatedEngine()
    const tool = buildTool({ engine, log: null })
    await tool.search({ query: QUERY })
    await tool.awaitShadowIdle()
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('when ON with no credential route, disables itself and the search is unaffected', async () => {
    process.env.KMS_JEV_SHADOW_RERANK = '1'
    const warn = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const tool = buildTool() // nothing injected → resolves from the (emptied) environment
      const first = await tool.search({ query: QUERY })
      await tool.search({ query: QUERY })
      await tool.awaitShadowIdle()

      expect(first.results.map(r => r.id)).toEqual(['keyword', 'semantic'])
      // Warned once, not once per search.
      expect(warn.mock.calls.filter(c => String(c[0]).includes('KMS_JEV_SHADOW_RERANK'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})
