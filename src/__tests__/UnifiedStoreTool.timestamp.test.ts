/**
 * Narrative-timestamp plumbing (follow-up to the mem0 temporal-stamp fix).
 *
 * unified_store now accepts `timestamp` (ISO 8601 string or epoch seconds)
 * and flows it into knowledge.timestamp, which Mem0Storage passes to mem0
 * add() as the event time (PR #121's storage-layer fix needs this to take
 * effect through the tool path). Verifies parsing, fallback on garbage, and
 * that the absent case still stamps now().
 */

import { UnifiedStoreTool } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'

function axisVec(): Float32Array {
  const v = new Float32Array(768)
  v[0] = 1
  return v
}

describe('UnifiedStoreTool — narrative timestamp arg', () => {
  let graph: any
  let tool: UnifiedStoreTool

  beforeEach(() => {
    const router = {
      determineStorage: jest.fn().mockReturnValue({
        primary: 'graph',
        secondary: [],
        cacheStrategy: 'L3',
        reasoning: 'test'
      }),
      getRoutingStats: jest.fn().mockReturnValue({})
    } as unknown as IntelligentStorageRouter
    graph = {
      name: 'sparrowdb',
      store: jest.fn().mockResolvedValue(undefined),
      storeEmbedding: jest.fn().mockResolvedValue(true),
      findSimilar: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockReturnValue(null),
      listFlagged: jest.fn().mockReturnValue([])
    } as unknown as GraphStorage
    const embedder = {
      embedderId: 'test',
      dimensions: 768,
      embed: jest.fn().mockResolvedValue(axisVec()),
      isAvailable: jest.fn().mockResolvedValue(true)
    } as unknown as EmbeddingService
    tool = new UnifiedStoreTool(
      router,
      { mongodb: { store: jest.fn() }, graph, mem0: { store: jest.fn() } },
      { get: jest.fn().mockResolvedValue(null), set: jest.fn(), invalidate: jest.fn() },
      null, null,
      embedder
    )
  })

  function storedKnowledge(): any {
    return (graph.store as jest.Mock).mock.calls[0][0]
  }

  it('plumbs an ISO string into knowledge.timestamp', async () => {
    await tool.store({
      content: 'Signed the lease on Maple Street on March 6, 2023',
      contentType: 'memory',
      source: 'personal',
      userId: 'dolphin/alex/p2',
      timestamp: '2023-03-06T12:00:00Z'
    } as any)

    expect(storedKnowledge().timestamp).toEqual(new Date('2023-03-06T12:00:00Z'))
  })

  it('plumbs epoch SECONDS into knowledge.timestamp', async () => {
    await tool.store({
      content: 'Moved into the apartment in January',
      contentType: 'memory',
      source: 'personal',
      userId: 'dolphin/alex/p2',
      timestamp: 1705336200
    } as any)

    // 1705336200 s === 2024-01-15T16:30:00Z
    expect(storedKnowledge().timestamp).toEqual(new Date('2024-01-15T16:30:00Z'))
  })

  it('falls back to now() on an unparseable timestamp, never an Invalid Date', async () => {
    const before = Date.now()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await tool.store({
        content: 'Untyped caller sent garbage',
        contentType: 'memory',
        source: 'personal',
        userId: 'dolphin/alex/p2',
        timestamp: 'not-a-date'
      } as any)
    } finally {
      warn.mockRestore()
    }

    const ts = storedKnowledge().timestamp as Date
    expect(Number.isFinite(ts.getTime())).toBe(true)
    expect(ts.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('defaults to now() when timestamp is absent', async () => {
    const before = Date.now()
    await tool.store({
      content: 'A plain present-tense write',
      contentType: 'memory',
      source: 'personal',
      userId: 'dolphin/alex/p2'
    } as any)

    const ts = storedKnowledge().timestamp as Date
    expect(ts.getTime()).toBeGreaterThanOrEqual(before)
  })
})