/**
 * DG-T1-A — embedding-on-write integration test (issue #43).
 *
 * Verifies the UnifiedStoreTool wires up the embedding pipeline correctly:
 *   1. Successful store → embed called → graph.store receives the vector
 *      via transient metadata.__pending_embedding (inline-MERGE path)
 *   2. metadata.embedder_id and metadata.embedded_at are set on every backend,
 *      but metadata.__pending_embedding/__pending_embedder_id ARE NOT (transient
 *      handoff fields scrubbed before non-graph backends see them)
 *   3. Ollama-unreachable case: store still succeeds, embedding skipped
 *   4. SparrowDB storeEmbedding-not-implemented case: store still succeeds
 *   5. No EmbeddingService injected: store works as before (back-compat)
 *
 * Why metadata-handoff and not a separate storeEmbedding() call: SparrowDB
 * 0.1.22's HNSW vector index is populated only when the embedding appears
 * INSIDE a MERGE/CREATE pattern's literal property dict. SET-on-existing-node
 * (the previous shape) silently no-ops — no error, no property stored, no HNSW
 * write. See channel msg #202 to SparrowDB session.
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

  it('calls embed() once and hands the vector to graph.store via transient metadata', async () => {
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

    // The new contract: graph.store receives the embedding inline via metadata
    // for HNSW population. The legacy storeEmbedding() is only used as a
    // fallback when the graph backend isn't part of the routing decision.
    const graphCalls = captured.filter(c => c.backend === 'graph')
    expect(graphCalls.length).toBe(1)
    const graphMeta = graphCalls[0].knowledge.metadata
    expect(graphMeta.__pending_embedding).toBeInstanceOf(Float32Array)
    expect(graphMeta.__pending_embedding.length).toBe(768)
    expect(graphMeta.__pending_embedder_id).toBe('nomic-embed-text:v1')

    // graph is the primary backend — fallback storeEmbedding() must NOT fire.
    const storeEmbeddingMock = (graph as any).storeEmbedding as jest.Mock
    expect(storeEmbeddingMock).not.toHaveBeenCalled()
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
    // Transient handoff fields must be scrubbed from non-graph backends —
    // they're only there to ride through SparrowDBStorage.store() and feed the
    // inline-MERGE pattern. Mongo/Mem0 should never see them.
    const nonGraph = captured.filter(c => c.backend !== 'graph')
    for (const cap of nonGraph) {
      expect(cap.knowledge.metadata.__pending_embedding).toBeUndefined()
      expect(cap.knowledge.metadata.__pending_embedder_id).toBeUndefined()
    }
  })

  it('graph.store sees the inline-embedding handoff fields on its metadata payload', async () => {
    let capturedMeta: any = null
    graph.store = jest.fn(async (k: any) => { capturedMeta = k.metadata })

    const tool = new UnifiedStoreTool(
      router, { mongodb: mongo, graph, mem0 }, cache, null, null, embedder
    )

    await tool.store({ content: 'order test', contentType: 'fact', userId: 'u' })

    expect(capturedMeta).not.toBeNull()
    // The vector must be present on graph.store's view of metadata — that's
    // how SparrowDBStorage knows to use the inline-MERGE pattern.
    expect(capturedMeta.__pending_embedding).toBeInstanceOf(Float32Array)
    expect(capturedMeta.__pending_embedder_id).toBe('nomic-embed-text:v1')
    // The legacy post-store storeEmbedding() fallback is not invoked when
    // graph is in the routing target list.
    expect((graph as any).storeEmbedding).not.toHaveBeenCalled()
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
