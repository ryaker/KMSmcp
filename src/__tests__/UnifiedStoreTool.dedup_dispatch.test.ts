/**
 * DG-T1-C — action dispatch tests (issue #46).
 *
 * These tests focus on the dispatcher path that runs when `args.action` is
 * set. The detection path (when args.action is *not* set) is covered by
 * UnifiedStoreTool.dedup_gate.test.ts; we keep the two files separate so
 * each focuses on one responsibility.
 *
 * Coverage:
 *   1. action=supersede dispatches to supersede() with mapped args
 *   2. action=supersede missing old_id → invalid_action, no dispatch
 *   3. action=supersede missing reason → invalid_action, no dispatch
 *   4. action=update dispatches to update() with mapped args
 *   5. action=update missing old_id → invalid_action, no dispatch
 *   6. action=update missing reason → invalid_action, no dispatch
 *   7. action=complement writes new entry with metadata.related_to (merged
 *      into any existing related_to array) and bypasses the gate
 *   8. action=complement missing related_to → invalid_action, no store
 *   9. action=force-new writes new entry with metadata.force_new_reason and
 *      bypasses the gate
 *  10. action=force-new missing reason → invalid_action, no store
 */

import { UnifiedStoreTool, type UnifiedStoreResult } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'

describe('DG-T1-C — UnifiedStoreTool action dispatch (issue #46)', () => {
  let mongo: any
  let graph: any
  let mem0: any
  let cache: any
  let router: IntelligentStorageRouter
  let embedder: jest.Mocked<EmbeddingService>

  function axisVec(axis: number): Float32Array {
    const v = new Float32Array(768)
    v[axis] = 1
    return v
  }

  beforeEach(() => {
    mongo = {
      store: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockResolvedValue(null),
      listFlagged: jest.fn().mockResolvedValue([])
    }

    graph = {
      name: 'sparrowdb',
      store: jest.fn().mockResolvedValue(undefined),
      storeEmbedding: jest.fn().mockResolvedValue(true),
      // Default: no candidates so a fall-through store path won't be blocked
      // by the gate. Individual tests that probe gate skipping override
      // findSimilar to inject a candidate that *would* refuse a normal store.
      findSimilar: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockReturnValue(null),
      listFlagged: jest.fn().mockReturnValue([])
    } as unknown as GraphStorage

    mem0 = {
      store: jest.fn().mockResolvedValue(undefined),
      deleteMemory: jest.fn().mockResolvedValue(true)
    }

    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined)
    }

    router = {
      determineStorage: jest.fn().mockReturnValue({
        primary: 'graph',
        secondary: ['mongodb', 'mem0'],
        cacheStrategy: 'L3',
        reasoning: 'test'
      }),
      getRoutingStats: jest.fn().mockReturnValue({})
    } as unknown as IntelligentStorageRouter

    embedder = {
      embedderId: 'nomic-embed-text:v1',
      dimensions: 768,
      embed: jest.fn().mockResolvedValue(axisVec(0)),
      isAvailable: jest.fn().mockResolvedValue(true)
    } as unknown as jest.Mocked<EmbeddingService>
  })

  function makeTool(): UnifiedStoreTool {
    return new UnifiedStoreTool(
      router,
      { mongodb: mongo, graph, mem0 },
      cache,
      null, null,
      embedder
    )
  }

  // -------------------------------------------------------------------------
  // 1. action=supersede dispatches correctly
  // -------------------------------------------------------------------------

  it('action=supersede dispatches to this.supersede() with mapped args', async () => {
    const tool = makeTool()
    // Spy on supersede to verify the args mapping without exercising the
    // full supersede→store→flag pipeline. Tests in
    // UnifiedStoreTool.supersede.routing.test.ts already cover the pipeline.
    const supersedeSpy = jest.spyOn(tool, 'supersede').mockResolvedValue({
      success: true,
      old_id: 'old-id-123',
      new_id: 'new-id-456',
      backends: ['sparrowdb', 'mongodb'],
      reason: 'corrected'
    })

    const result = await tool.store({
      content: 'corrected content',
      contentType: 'fact',
      source: 'technical',
      userId: 'richard_yaker',
      confidence: 0.9,
      metadata: { subject: 'Phoenix.camera_count' },
      action: 'supersede',
      old_id: 'old-id-123',
      reason: 'corrected'
    } as any)

    expect(supersedeSpy).toHaveBeenCalledTimes(1)
    expect(supersedeSpy).toHaveBeenCalledWith({
      old_id: 'old-id-123',
      new_content: 'corrected content',
      contentType: 'fact',
      source: 'technical',
      userId: 'richard_yaker',
      confidence: 0.9,
      metadata: { subject: 'Phoenix.camera_count' },
      reason: 'corrected'
    })

    // Result is the supersede shape (terminal — no normal store fan-out)
    expect((result as any).status).toBe('superseded')
    expect((result as any).success).toBe(true)
    expect((result as any).id).toBe('new-id-456')
    expect((result as any).old_id).toBe('old-id-123')
    expect((result as any).backends).toEqual(['sparrowdb', 'mongodb'])

    // Critical: no normal store fan-out happened from the dispatcher
    expect(graph.store).not.toHaveBeenCalled()
    expect(mongo.store).not.toHaveBeenCalled()
    expect(mem0.store).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 2 + 3. action=supersede validation
  // -------------------------------------------------------------------------

  it('action=supersede with no old_id returns invalid_action and does not dispatch', async () => {
    const tool = makeTool()
    const supersedeSpy = jest.spyOn(tool, 'supersede')

    const result = await tool.store({
      content: 'no old_id',
      contentType: 'fact',
      action: 'supersede',
      reason: 'fixing'
    } as any)

    expect((result as any).status).toBe('invalid_action')
    expect((result as any).success).toBe(false)
    expect((result as any).error).toMatch(/old_id/)
    expect(supersedeSpy).not.toHaveBeenCalled()
    // No normal store happened either
    expect(graph.store).not.toHaveBeenCalled()
  })

  it('action=supersede with no reason returns invalid_action and does not dispatch', async () => {
    const tool = makeTool()
    const supersedeSpy = jest.spyOn(tool, 'supersede')

    const result = await tool.store({
      content: 'no reason',
      contentType: 'fact',
      action: 'supersede',
      old_id: 'old-id-123'
    } as any)

    expect((result as any).status).toBe('invalid_action')
    expect((result as any).success).toBe(false)
    expect((result as any).error).toMatch(/reason/)
    expect(supersedeSpy).not.toHaveBeenCalled()
    expect(graph.store).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 4. action=update dispatches correctly
  // -------------------------------------------------------------------------

  it('action=update dispatches to this.update() with mapped args', async () => {
    const tool = makeTool()
    const updateSpy = jest.spyOn(tool, 'update').mockResolvedValue({
      success: true,
      id: 'old-id-123',
      backends: ['sparrowdb', 'mongodb'],
      reason: 'typo fix'
    })

    const result = await tool.store({
      content: 'corrected content',
      metadata: { extra: 'meta' },
      confidence: 0.95,
      action: 'update',
      old_id: 'old-id-123',
      reason: 'typo fix'
    } as any)

    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith({
      id: 'old-id-123',
      content: 'corrected content',
      metadata: { extra: 'meta' },
      confidence: 0.95,
      reason: 'typo fix'
    })

    expect((result as any).status).toBe('updated')
    expect((result as any).success).toBe(true)
    expect((result as any).id).toBe('old-id-123')
    expect((result as any).backends).toEqual(['sparrowdb', 'mongodb'])

    // No normal store fan-out
    expect(graph.store).not.toHaveBeenCalled()
    expect(mongo.store).not.toHaveBeenCalled()
    expect(mem0.store).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 5 + 6. action=update validation
  // -------------------------------------------------------------------------

  it('action=update with no old_id returns invalid_action and does not dispatch', async () => {
    const tool = makeTool()
    const updateSpy = jest.spyOn(tool, 'update')

    const result = await tool.store({
      content: 'fix',
      action: 'update',
      reason: 'fixing'
    } as any)

    expect((result as any).status).toBe('invalid_action')
    expect((result as any).error).toMatch(/old_id/)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(graph.store).not.toHaveBeenCalled()
  })

  it('action=update with no reason returns invalid_action and does not dispatch', async () => {
    const tool = makeTool()
    const updateSpy = jest.spyOn(tool, 'update')

    const result = await tool.store({
      content: 'fix',
      action: 'update',
      old_id: 'old-id-123'
    } as any)

    expect((result as any).status).toBe('invalid_action')
    expect((result as any).error).toMatch(/reason/)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(graph.store).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 7. action=complement writes new entry with related_to
  // -------------------------------------------------------------------------

  it('action=complement writes a new entry with metadata.related_to and bypasses the gate', async () => {
    // Inject a refuse-band candidate so we can prove the gate was bypassed
    // (a normal store with this candidate would return dedup_required).
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'existing-id',
        similarity: 0.99,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'would-have-blocked'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'a related but distinct fact',
      contentType: 'fact',
      userId: 'richard_yaker',
      action: 'complement',
      related_to: 'existing-id'
    } as any)

    // Result is a normal successful store (we fell through after mutating args)
    expect((result as any).status).toBeUndefined()
    expect((result as any).success).toBe(true)

    // The fan-out happened because the gate was bypassed via skip_dedup
    expect(graph.store).toHaveBeenCalledTimes(1)
    const knowledgeWritten = (graph.store as jest.Mock).mock.calls[0][0]
    expect(knowledgeWritten.metadata.related_to).toEqual(['existing-id'])
    // Gate must not have been queried (skip_dedup was forced on by the dispatcher)
    expect((graph as any).findSimilar).not.toHaveBeenCalled()
  })

  it('action=complement merges related_to with any pre-existing array on metadata', async () => {
    const tool = makeTool()
    await tool.store({
      content: 'complementing two existing entries',
      contentType: 'fact',
      userId: 'richard_yaker',
      metadata: { related_to: ['prior-related-1'] },
      action: 'complement',
      related_to: 'existing-id-2'
    } as any)

    const knowledgeWritten = (graph.store as jest.Mock).mock.calls[0][0]
    expect(knowledgeWritten.metadata.related_to).toEqual(['prior-related-1', 'existing-id-2'])
  })

  it('action=complement with duplicate related_to does not double-add', async () => {
    const tool = makeTool()
    await tool.store({
      content: 'idempotent complement',
      contentType: 'fact',
      userId: 'richard_yaker',
      metadata: { related_to: ['existing-id'] },
      action: 'complement',
      related_to: 'existing-id'
    } as any)

    const knowledgeWritten = (graph.store as jest.Mock).mock.calls[0][0]
    expect(knowledgeWritten.metadata.related_to).toEqual(['existing-id'])
  })

  // -------------------------------------------------------------------------
  // 8. action=complement validation
  // -------------------------------------------------------------------------

  it('action=complement with no related_to returns invalid_action and does not store', async () => {
    const tool = makeTool()
    const result = await tool.store({
      content: 'no related_to',
      contentType: 'fact',
      action: 'complement'
    } as any)

    expect((result as any).status).toBe('invalid_action')
    expect((result as any).error).toMatch(/related_to/)
    expect(graph.store).not.toHaveBeenCalled()
    expect(mongo.store).not.toHaveBeenCalled()
    expect(mem0.store).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 9. action=force-new writes new entry with force_new_reason
  // -------------------------------------------------------------------------

  it('action=force-new writes a new entry with metadata.force_new_reason and bypasses the gate', async () => {
    // Inject a refuse-band candidate to prove the gate was bypassed
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'existing-id',
        similarity: 0.99,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'would-have-blocked'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'genuinely-distinct content despite high cosine',
      contentType: 'fact',
      userId: 'richard_yaker',
      action: 'force-new',
      reason: 'embedder collapsed unrelated topics; manual override after audit'
    } as any)

    expect((result as any).status).toBeUndefined()
    expect((result as any).success).toBe(true)

    expect(graph.store).toHaveBeenCalledTimes(1)
    const knowledgeWritten = (graph.store as jest.Mock).mock.calls[0][0]
    expect(knowledgeWritten.metadata.force_new_reason).toBe(
      'embedder collapsed unrelated topics; manual override after audit'
    )
    // Gate bypassed
    expect((graph as any).findSimilar).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 10. action=force-new validation
  // -------------------------------------------------------------------------

  it('action=force-new with no reason returns invalid_action and does not store', async () => {
    const tool = makeTool()
    const result = await tool.store({
      content: 'no reason',
      contentType: 'fact',
      action: 'force-new'
    } as any)

    expect((result as any).status).toBe('invalid_action')
    expect((result as any).error).toMatch(/reason/)
    expect(graph.store).not.toHaveBeenCalled()
    expect(mongo.store).not.toHaveBeenCalled()
    expect(mem0.store).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Cross-cutting: dispatch result type discrimination
  // -------------------------------------------------------------------------

  it('supersede dispatch propagates failure from underlying supersede()', async () => {
    const tool = makeTool()
    jest.spyOn(tool, 'supersede').mockResolvedValue({
      success: false,
      old_id: 'old-id-123',
      error: 'old_id not found in any backend'
    })

    const result = await tool.store({
      content: 'will fail',
      action: 'supersede',
      old_id: 'old-id-123',
      reason: 'fix'
    } as any)

    expect((result as any).status).toBe('superseded')
    expect((result as any).success).toBe(false)
    expect((result as any).error).toMatch(/not found/)
  })

  it('update dispatch propagates failure from underlying update()', async () => {
    const tool = makeTool()
    jest.spyOn(tool, 'update').mockResolvedValue({
      success: false,
      id: 'old-id-123',
      backends: []
    })

    const result: UnifiedStoreResult = await tool.store({
      content: 'will fail',
      action: 'update',
      old_id: 'old-id-123',
      reason: 'fix'
    } as any)

    expect((result as any).status).toBe('updated')
    expect((result as any).success).toBe(false)
    expect((result as any).backends).toEqual([])
  })
})
