/**
 * Shadow write-dedup wired into UnifiedStoreTool.store() — Jev Experiment 2.
 *
 * Gated on KMS_JEV_WRITE_DEDUP=1, default OFF. The contract these tests pin is the word
 * "shadow": with the flag on, the engine is consulted and a decision row is written, and
 * what `unified_store` returns AND what it does to storage are exactly what they would
 * have been with the flag off — whatever the engine says, and with ACT set too.
 */

import { UnifiedStoreTool } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'
import type { LLMJudgeService } from '../embedding/LLMJudgeService.js'
import type { DecisionEngine, DecisionLogSink, DecisionResult, WriteDedupLogRow, WriteDedupRunRecord } from '../decision/index.js'
import { WRITE_DEDUP_NOULS, WRITE_DEDUP_RELATIONS, type WriteDedupRelation } from '../decision/writeDedupRelation.js'

const FLAGS = ['KMS_JEV_WRITE_DEDUP', 'KMS_JEV_WRITE_DEDUP_ACT', 'KMS_JEV_WRITE_DEDUP_MIN_SIM'] as const
const CREDENTIAL_ENV = ['ONECLI_TOKEN', 'ONECLI_GATEWAY', 'TYPESAFE_API_KEY'] as const

const NEW_CONTENT = 'The Phoenix rig uses 16 cameras.'
const EXISTING = { id: 'old-1', content: 'The Phoenix rig uses 6 cameras per the March calibration.', metadata: {} }

const unitVec = (): Float32Array => { const v = new Float32Array(768); v[0] = 1; return v }

const hit = (similarity: number) => ({
  id: EXISTING.id, similarity, contentType: 'fact', source: 'technical', created: '2026-03-10T00:00:00Z',
  flag: null, content_preview: EXISTING.content.slice(0, 200),
})

/** An engine that is confidently, maximally wrong in the most dangerous direction. */
const engineSaying = (relation: WriteDedupRelation) => {
  const evaluate = jest.fn(async (): Promise<DecisionResult> => ({
    provider: 'mock', model: 'mock-1', requestedModel: 'mock-latest',
    answers: {
      relation: {
        type: 'choice', choice: relation, confidence: 0.99,
        probabilities: Object.fromEntries(WRITE_DEDUP_RELATIONS.map(r => [r, r === relation ? 0.99 : 0.002])),
      },
      ...Object.fromEntries(WRITE_DEDUP_NOULS.map(id => [id, { type: 'noul' as const, probability: id === 'same_subject' ? 0.99 : 0.01 }])),
    },
    usage: { inputTokens: 400, outputTokens: 10 }, latencyMs: 15, costUsdEstimate: 0.0000168,
  }))
  const engine: DecisionEngine = { provider: 'mock', requestedModel: 'mock-latest', evaluate }
  return { engine, evaluate }
}

const memoryLog = () => {
  const rows: WriteDedupLogRow[] = []
  const log: DecisionLogSink<WriteDedupLogRow> = { write: jest.fn(async r => { rows.push(r) }) }
  return { log, rows }
}

const build = (similarity: number | null, decision?: { engine?: DecisionEngine | null, log?: DecisionLogSink<WriteDedupLogRow> | null }) => {
  const mongo: any = {
    store: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(true), flag: jest.fn().mockResolvedValue(true),
    findById: jest.fn().mockResolvedValue(null), listFlagged: jest.fn().mockResolvedValue([]),
  }
  const graph: any = {
    name: 'sparrowdb',
    store: jest.fn().mockResolvedValue(undefined), storeEmbedding: jest.fn().mockResolvedValue(true),
    findSimilar: jest.fn().mockResolvedValue(similarity === null ? [] : [hit(similarity)]),
    update: jest.fn().mockResolvedValue(true), delete: jest.fn().mockResolvedValue(true),
    flag: jest.fn().mockResolvedValue(true), findById: jest.fn().mockReturnValue(EXISTING),
    listFlagged: jest.fn().mockReturnValue([]),
  }
  const mem0: any = { store: jest.fn().mockResolvedValue(undefined), deleteMemory: jest.fn().mockResolvedValue(true) }
  const cache: any = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), invalidate: jest.fn().mockResolvedValue(undefined) }
  const router = {
    determineStorage: jest.fn().mockReturnValue({ primary: 'graph', secondary: ['mongodb', 'mem0'], cacheStrategy: 'L3', reasoning: 'test' }),
    getRoutingStats: jest.fn().mockReturnValue({}),
  } as unknown as IntelligentStorageRouter
  const embedder = {
    embedderId: 'nomic-embed-text:v1', dimensions: 768,
    embed: jest.fn().mockResolvedValue(unitVec()), isAvailable: jest.fn().mockResolvedValue(true),
  } as unknown as EmbeddingService
  const judge = {
    modelId: 'qwen3:8b',
    classify: jest.fn().mockResolvedValue('contradicts'), isAvailable: jest.fn().mockResolvedValue(true),
  } as unknown as LLMJudgeService
  const tool = new UnifiedStoreTool(router, { mongodb: mongo, graph, mem0 }, cache, null, null, embedder, judge, decision)
  return { tool, mongo, graph, mem0 }
}

const storeArgs = () => ({ content: NEW_CONTENT, contentType: 'fact' as const, source: 'technical' as const, userId: 'richard_yaker', metadata: { subject: 'Phoenix.camera_count' } })

/** A store result minus what differs between any two runs (the generated id, wall-clock). */
const stable = (r: any) => {
  const { id: _id, performance: _performance, ...rest } = r
  return rest
}

/** Every mutating call the backends received, minus the generated entry id. */
const writes = ({ mongo, graph, mem0 }: ReturnType<typeof build>) => ({
  stores: [mongo.store, graph.store, mem0.store].map(f => f.mock.calls.length),
  destructive: [mongo.update, mongo.delete, mongo.flag, graph.update, graph.delete, graph.flag, mem0.deleteMemory].map(f => f.mock.calls.length),
})

const runs = (rows: WriteDedupLogRow[]) => rows.filter((r): r is WriteDedupRunRecord => r.kind === 'write_dedup_shadow_run')

describe('UnifiedStoreTool write-dedup shadow', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const name of [...FLAGS, ...CREDENTIAL_ENV]) { saved[name] = process.env[name]; delete process.env[name] }
  })
  afterEach(() => {
    for (const name of [...FLAGS, ...CREDENTIAL_ENV]) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  it('is off by default: no engine call, no log row', async () => {
    const { engine, evaluate } = engineSaying('duplicate')
    const { log, rows } = memoryLog()
    const built = build(0.84, { engine, log })
    await built.tool.store(storeArgs())
    await built.tool.awaitWriteDedupShadowIdle()
    expect(evaluate).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it('does not treat KMS_JEV_WRITE_DEDUP=true as on', async () => {
    process.env.KMS_JEV_WRITE_DEDUP = 'true'
    const { engine, evaluate } = engineSaying('duplicate')
    const built = build(0.84, { engine, log: memoryLog().log })
    await built.tool.store(storeArgs())
    await built.tool.awaitWriteDedupShadowIdle()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('dedup_required: logs the judgment beside the Tier 2 relation, and returns the same response', async () => {
    const baseline = build(0.84)
    const expected = await baseline.tool.store(storeArgs())

    process.env.KMS_JEV_WRITE_DEDUP = '1'
    const { engine, evaluate } = engineSaying('unrelated')
    const { log, rows } = memoryLog()
    const built = build(0.84, { engine, log })
    const actual = await built.tool.store(storeArgs())
    await built.tool.awaitWriteDedupShadowIdle()

    expect((actual as any).status).toBe('dedup_required')
    expect(actual).toEqual(expected)
    expect(writes(built)).toEqual(writes(baseline))
    expect(writes(built).stores).toEqual([0, 0, 0])

    expect(evaluate).toHaveBeenCalledTimes(1)
    expect((evaluate.mock.calls[0] as any)[0].state.candidate.content).toBe(EXISTING.content)
    expect(runs(rows)).toHaveLength(1)
    expect(runs(rows)[0]).toMatchObject({
      policy_decision: 'shadow_log',
      gate: { outcome: 'dedup_required', band: 'confirm', thresholds: { refuse: 0.88, confirm: 0.78 } },
      assertion: { content_type: 'fact', subject: 'Phoenix.camera_count', user_id: 'richard_yaker' },
      policy_proposal: 'store_new',
      candidates: [{ id: 'old-1', vector_similarity: 0.84, gate_band: 'confirm', tier2_llm_relation: 'contradicts' }],
    })
  })

  it('proceeded: judges the near-miss the gate let through, and the write still happens — even if Jev says "duplicate"', async () => {
    const baseline = build(0.7)
    const expected = await baseline.tool.store(storeArgs())

    process.env.KMS_JEV_WRITE_DEDUP = '1'
    process.env.KMS_JEV_WRITE_DEDUP_ACT = '1'
    const { engine } = engineSaying('duplicate')
    const { log, rows } = memoryLog()
    const built = build(0.7, { engine, log })
    const actual = await built.tool.store(storeArgs())
    await built.tool.awaitWriteDedupShadowIdle()

    expect((actual as any).success).toBe(true)
    expect(stable(actual)).toEqual(stable(expected))
    expect(writes(built)).toEqual(writes(baseline))
    expect(writes(built).destructive.every(n => n === 0)).toBe(true)

    expect(runs(rows)[0]).toMatchObject({
      act_requested: true,
      policy_decision: 'shadow_log',
      gate: { outcome: 'proceeded', band: null },
      assertion: { entry_id: (actual as any).id },
      policy_proposal: 'suggest_skip_duplicate',
      candidates: [{ gate_band: 'below_confirm', tier2_llm_relation: null }],
    })
  })

  it('does not judge pairs under the similarity floor, or writes with no candidates', async () => {
    process.env.KMS_JEV_WRITE_DEDUP = '1'
    const { engine, evaluate } = engineSaying('duplicate')
    const { log, rows } = memoryLog()
    for (const similarity of [0.4, null]) {
      const built = build(similarity, { engine, log })
      await built.tool.store(storeArgs())
      await built.tool.awaitWriteDedupShadowIdle()
    }
    expect(evaluate).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it('an engine that always throws costs a row, never the write', async () => {
    process.env.KMS_JEV_WRITE_DEDUP = '1'
    const engine: DecisionEngine = { provider: 'mock', requestedModel: 'mock-latest', evaluate: jest.fn().mockRejectedValue(new Error('gateway down')) }
    const { log, rows } = memoryLog()
    const built = build(0.7, { engine, log })
    const actual = await built.tool.store(storeArgs())
    await built.tool.awaitWriteDedupShadowIdle()
    expect((actual as any).success).toBe(true)
    expect(runs(rows)[0]).toMatchObject({ candidates_failed: 1, policy_proposal: null })
  })

  it('disables itself, without failing the write, when there is no credential route', async () => {
    process.env.KMS_JEV_WRITE_DEDUP = '1'
    const warn = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const built = build(0.7)
      const actual = await built.tool.store(storeArgs())
      await built.tool.awaitWriteDedupShadowIdle()
      expect((actual as any).success).toBe(true)
      expect(warn.mock.calls.flat().join('\n')).toMatch(/KMS_JEV_WRITE_DEDUP=1 but no Jev credential route/)
    } finally {
      warn.mockRestore()
    }
  })

  // The dedup_required call site is inside the gate's own try/catch, whose handler means
  // "findSimilar failed, write anyway". A throw while STARTING the shadow path (undici
  // rejects a scheme-less proxy URI synchronously) must not be able to reach it.
  it('a broken credential env cannot turn a refused write into a stored one', async () => {
    const baseline = build(0.84)
    const expected = await baseline.tool.store(storeArgs())

    process.env.KMS_JEV_WRITE_DEDUP = '1'
    process.env.ONECLI_TOKEN = 'placeholder'
    process.env.ONECLI_GATEWAY = 'localhost:8080'
    const built = build(0.84, { log: memoryLog().log })
    const first = await built.tool.store(storeArgs())
    const second = await built.tool.store(storeArgs())
    await built.tool.awaitWriteDedupShadowIdle()

    expect((first as any).status).toBe('dedup_required')
    expect(first).toEqual(expected)
    expect(second).toEqual(expected)
    expect(writes(built).stores).toEqual([0, 0, 0])
  })

  it('logs the caller\'s retry action as a resolution row, without the reason text', async () => {
    process.env.KMS_JEV_WRITE_DEDUP = '1'
    const { engine, evaluate } = engineSaying('duplicate')
    const { log, rows } = memoryLog()
    const built = build(0.95, { engine, log })
    await built.tool.store({ ...storeArgs(), action: 'force-new', reason: 'SECRET-REASON scoped to a different rig' })
    await built.tool.awaitWriteDedupShadowIdle()

    expect(rows).toEqual([expect.objectContaining({ kind: 'write_dedup_resolution', caller_action: 'force-new', target_id: null })])
    expect(JSON.stringify(rows)).not.toContain('SECRET-REASON')
    // force-new skips the gate, so there are no candidates and nothing to judge.
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('does not log a resolution for an invalid action', async () => {
    process.env.KMS_JEV_WRITE_DEDUP = '1'
    const { log, rows } = memoryLog()
    const built = build(0.95, { engine: engineSaying('duplicate').engine, log })
    const r = await built.tool.store({ ...storeArgs(), action: 'supersede' })
    await built.tool.awaitWriteDedupShadowIdle()
    expect((r as any).status).toBe('invalid_action')
    expect(rows).toEqual([])
  })
})
