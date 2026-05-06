/**
 * DG-T1-A — embedding-on-write integration test (issue #43).
 *
 * Verifies the UnifiedStoreTool wires up the embedding pipeline correctly:
 *   1. Successful store → embed called → storeEmbedding called with right args
 *   2. metadata.embedder_id and metadata.embedded_at are set on every backend
 *   3. Ollama-unreachable case: store still succeeds, embedding skipped
 *   4. SparrowDB storeEmbedding-not-implemented case: store still succeeds
 *   5. No EmbeddingService injected: store works as before (back-compat)
 */

import { UnifiedStoreTool } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'

describe('DG-T1-A — UnifiedStoreTool embedding-on-write (issue #43)', () => {
  let mongo: any
  let graph: any
  let mem0: any
  let cache: any
  let router: IntelligentStorageRouter
  let embedder: jest.Mocked<EmbeddingService>

  // Capture every UnifiedKnowledge handed to each backend so we can inspect
  // metadata propagation after the unified routing layer runs.
  const captured: { backend: string; knowledge: any }[] = []

  function makeVec(dim = 768): Float32Array {
    const v = new Float32Array(dim)
    for (let i = 0; i < dim; i++) v[i] = i / dim
    return v
  }

  beforeEach(() => {
    captured.length = 0

    mongo = {
      store: jest.fn(async (k: any) => { captured.push({ backend: 'mongodb', knowledge: k }) }),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      listFlagged: jest.fn().mockResolvedValue([])
    }

    graph = {
      name: 'sparrowdb',
      store: jest.fn(async (k: any) => { captured.push({ backend: 'graph', knowledge: k }) }),
      storeEmbedding: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockReturnValue(null),
      listFlagged: jest.fn().mockReturnValue([])
    } as unknown as GraphStorage

    mem0 = {
      store: jest.fn(async (k: any) => { captured.push({ backend: 'mem0', knowledge: k }) }),
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
      embed: jest.fn().mockResolvedValue(makeVec()),
      isAvailable: jest.fn().mockResolvedValue(true)
    } as unknown as jest.Mocked<EmbeddingService>
  })

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('calls embed() once and storeEmbedding() with the resulting vector', async () => {
    const tool = new UnifiedStoreTool(
      router,
      { mongodb: mongo, graph, mem0 },
      cache,
      null, null,
      embedder
    )

    const result = await tool.store({
      content: 'this is a test fact for the dedup gate',
      contentType: 'fact',
      source: 'technical',
      userId: 'test-user'
    })

    expect(result.success).toBe(true)
    expect(embedder.embed).toHaveBeenCalledTimes(1)
    expect(embedder.embed).toHaveBeenCalledWith('this is a test fact for the dedup gate')

    const storeEmbeddingMock = (graph as any).storeEmbedding as jest.Mock
    expect(storeEmbeddingMock).toHaveBeenCalledTimes(1)
    const [id, vec, embedderId] = storeEmbeddingMock.mock.calls[0]
    expect(id).toBe(result.id)
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(768)
    expect(embedderId).toBe('nomic-embed-text:v1')
  })

  it('persists metadata.embedder_id and metadata.embedded_at on every backend', async () => {
    const tool = new UnifiedStoreTool(
      router,
      { mongodb: mongo, graph, mem0 },
      cache,
      null, null,
      embedder
    )

    await tool.store({
      content: 'persist embed metadata test',
      userId: 'u',
      contentType: 'fact'
    })

    expect(captured.length).toBe(3)  // graph + mongodb + mem0
    for (const cap of captured) {
      expect(cap.knowledge.metadata.embedder_id).toBe('nomic-embed-text:v1')
      expect(typeof cap.knowledge.metadata.embedded_at).toBe('string')
      // Timestamp must parse to a valid date.
      expect(Number.isNaN(Date.parse(cap.knowledge.metadata.embedded_at))).toBe(false)
    }
  })

  it('storeEmbedding is called AFTER the graph store (node must exist first)', async () => {
    const callOrder: string[] = []
    graph.store = jest.fn(async () => { callOrder.push('graph.store') })
    ;(graph as any).storeEmbedding = jest.fn(async () => { callOrder.push('storeEmbedding') })

    const tool = new UnifiedStoreTool(
      router, { mongodb: mongo, graph, mem0 }, cache, null, null, embedder
    )

    await tool.store({ content: 'order test', contentType: 'fact', userId: 'u' })

    const graphIdx = callOrder.indexOf('graph.store')
    const embedIdx = callOrder.indexOf('storeEmbedding')
    expect(graphIdx).toBeGreaterThanOrEqual(0)
    expect(embedIdx).toBeGreaterThan(graphIdx)
  })

  // -------------------------------------------------------------------------
  // Ollama unreachable — store must still succeed
  // -------------------------------------------------------------------------

  it('store succeeds when embed() throws (Ollama unreachable)', async () => {
    embedder.embed = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const tool = new UnifiedStoreTool(
      router, { mongodb: mongo, graph, mem0 }, cache, null, null, embedder
    )

    const result = await tool.store({
      content: 'embed failure test',
      contentType: 'fact',
      userId: 'u'
    })

    expect(result.success).toBe(true)
    // storeEmbedding NOT called when embed failed
    expect((graph as any).storeEmbedding).not.toHaveBeenCalled()
    // Backends still received the entry, but WITHOUT embedder_id / embedded_at
    expect(captured.length).toBe(3)
    for (const cap of captured) {
      expect(cap.knowledge.metadata.embedder_id).toBeUndefined()
      expect(cap.knowledge.metadata.embedded_at).toBeUndefined()
    }
  })

  it('store succeeds when SparrowDB.storeEmbedding throws (graph write error)', async () => {
    ;(graph as any).storeEmbedding = jest.fn().mockRejectedValue(new Error('graph SET failed'))

    const tool = new UnifiedStoreTool(
      router, { mongodb: mongo, graph, mem0 }, cache, null, null, embedder
    )

    const result = await tool.store({
      content: 'storeEmbedding failure test',
      contentType: 'fact',
      userId: 'u'
    })

    expect(result.success).toBe(true)
    // Embed was attempted and metadata flags persisted (the embedding attempt succeeded;
    // only the vector persistence failed)
    expect(embedder.embed).toHaveBeenCalled()
    for (const cap of captured) {
      expect(cap.knowledge.metadata.embedder_id).toBe('nomic-embed-text:v1')
    }
  })

  it('store succeeds when graph backend has no storeEmbedding method (older binding)', async () => {
    delete (graph as any).storeEmbedding

    const tool = new UnifiedStoreTool(
      router, { mongodb: mongo, graph, mem0 }, cache, null, null, embedder
    )

    const result = await tool.store({
      content: 'old binding test',
      contentType: 'fact',
      userId: 'u'
    })

    expect(result.success).toBe(true)
    expect(embedder.embed).toHaveBeenCalled()  // embed still attempted
    // metadata flag still on the record so consumers know an embedder ran
    for (const cap of captured) {
      expect(cap.knowledge.metadata.embedder_id).toBe('nomic-embed-text:v1')
    }
  })

  // -------------------------------------------------------------------------
  // Back-compat: no embedder injected
  // -------------------------------------------------------------------------

  it('store works when no EmbeddingService is provided (legacy path)', async () => {
    const tool = new UnifiedStoreTool(
      router, { mongodb: mongo, graph, mem0 }, cache, null, null
      // <-- no embedder argument
    )

    const result = await tool.store({
      content: 'no embedder test',
      contentType: 'fact',
      userId: 'u'
    })

    expect(result.success).toBe(true)
    expect((graph as any).storeEmbedding).not.toHaveBeenCalled()
    for (const cap of captured) {
      expect(cap.knowledge.metadata.embedder_id).toBeUndefined()
    }
  })
})
