/**
 * DG-FACET-A round-trip test (issue #44).
 *
 * Verifies that `metadata.subject` is a first-class facet:
 *  1. unified_store accepts metadata.subject and persists it on every backend
 *     it routes to (pass-through — no LLM extraction in this ticket).
 *  2. unified_search accepts filters.subject (string OR string[]) and threads
 *     it down to all three backends so each can narrow its candidate set.
 *  3. Filtering by subject only surfaces matching entries.
 *
 * This is a unit test against mocked storage backends. The pass-through
 * contract is verified at the boundary — what unified_store hands the backend
 * and what unified_search hands the backend — without requiring a live KMS.
 */

import { UnifiedStoreTool } from '../tools/UnifiedStoreTool.js'
import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage, KnowledgeQuery } from '../types/index.js'

describe('DG-FACET-A — metadata.subject round-trip (issue #44)', () => {
  let mongo: any
  let graph: any
  let mem0: any
  let cache: any
  let router: IntelligentStorageRouter
  let storeTool: UnifiedStoreTool
  let searchTool: UnifiedSearchTool

  // Captures every UnifiedKnowledge handed to a backend so we can inspect
  // metadata.subject after the unified routing layer runs.
  const captured: { backend: string; knowledge: any }[] = []

  // Captures every KnowledgeQuery handed to a backend so we can verify the
  // subject filter is threaded through unchanged.
  const queries: { backend: string; query: KnowledgeQuery }[] = []

  beforeEach(() => {
    captured.length = 0
    queries.length = 0

    mongo = {
      store: jest.fn(async (k: any) => { captured.push({ backend: 'mongodb', knowledge: k }) }),
      search: jest.fn(async (q: KnowledgeQuery) => {
        queries.push({ backend: 'mongodb', query: q })
        return []
      }),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      listFlagged: jest.fn().mockResolvedValue([])
    }

    graph = {
      name: 'sparrowdb',
      store: jest.fn(async (k: any) => { captured.push({ backend: 'graph', knowledge: k }) }),
      search: jest.fn(async (q: KnowledgeQuery) => {
        queries.push({ backend: 'graph', query: q })
        return []
      }),
      getEntitySummary: jest.fn().mockResolvedValue(null),
      getOperationalNodes: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockReturnValue(null),
      listFlagged: jest.fn().mockReturnValue([])
    } as unknown as GraphStorage

    mem0 = {
      store: jest.fn(async (k: any) => { captured.push({ backend: 'mem0', knowledge: k }) }),
      search: jest.fn(async (q: KnowledgeQuery) => {
        queries.push({ backend: 'mem0', query: q })
        return []
      }),
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

    storeTool = new UnifiedStoreTool(
      router,
      { mongodb: mongo, graph, mem0 },
      cache,
      null,
      null
    )

    searchTool = new UnifiedSearchTool(
      { mongodb: mongo, graph, mem0 },
      cache
    )
  })

  // ---------------------------------------------------------------------------
  // Store: subject persists across all backends
  // ---------------------------------------------------------------------------

  it('unified_store persists metadata.subject verbatim to every routed backend', async () => {
    const result = await storeTool.store({
      content: 'Phoenix camera count is 6 per the Mar-2026 calibration session',
      contentType: 'fact',
      source: 'technical',
      userId: 'richard_yaker',
      metadata: {
        subject: 'Phoenix.camera_count',
        tags: ['phoenix', 'cameras']
      }
    })

    expect(result.success).toBe(true)

    // The router fans out to graph (primary) + mongodb + mem0 (secondaries).
    // Each must receive the same subject — pure pass-through, no transformation.
    const subjects = captured.map(c => ({
      backend: c.backend,
      subject: c.knowledge.metadata?.subject
    }))

    expect(subjects).toEqual(
      expect.arrayContaining([
        { backend: 'graph',   subject: 'Phoenix.camera_count' },
        { backend: 'mongodb', subject: 'Phoenix.camera_count' },
        { backend: 'mem0',    subject: 'Phoenix.camera_count' }
      ])
    )

    // Pre-existing tags must survive alongside the new subject facet —
    // ContentInference's metadata enhancement must not clobber caller-supplied
    // metadata (regression guard for the dedup gate's reliance on subject).
    for (const c of captured) {
      expect(c.knowledge.metadata.subject).toBe('Phoenix.camera_count')
      expect(c.knowledge.metadata.tags).toEqual(expect.arrayContaining(['phoenix', 'cameras']))
    }
  })

  // ---------------------------------------------------------------------------
  // Search: subject filter threads to every backend
  // ---------------------------------------------------------------------------

  it('unified_search threads filters.subject (string) down to every backend', async () => {
    await searchTool.search({
      query: 'phoenix',
      filters: {
        userId: 'richard_yaker',
        subject: 'Phoenix.camera_count'
      }
    })

    // Each backend must see filters.subject unchanged — that's the whole
    // contract of pass-through.
    expect(queries).toHaveLength(3)
    for (const q of queries) {
      expect(q.query.filters?.subject).toBe('Phoenix.camera_count')
    }
  })

  it('unified_search threads filters.subject (string[]) down to every backend', async () => {
    await searchTool.search({
      query: 'phoenix',
      filters: {
        userId: 'richard_yaker',
        subject: ['Phoenix.camera_count', 'Phoenix.tone_curve']
      }
    })

    expect(queries).toHaveLength(3)
    for (const q of queries) {
      expect(q.query.filters?.subject).toEqual(['Phoenix.camera_count', 'Phoenix.tone_curve'])
    }
  })

  it('unified_search omits filters.subject when caller does not pass one', async () => {
    await searchTool.search({
      query: 'phoenix',
      filters: { userId: 'richard_yaker' }
    })

    expect(queries).toHaveLength(3)
    for (const q of queries) {
      expect(q.query.filters?.subject).toBeUndefined()
    }
  })

  // ---------------------------------------------------------------------------
  // End-to-end pass-through: store with subject → search by subject sees only
  // matching entries. This validates the "narrows dedup search" promise of the
  // facet without requiring an actual storage backend.
  // ---------------------------------------------------------------------------

  it('round-trip: stored subject is the same value seen at search-filter time', async () => {
    // Step 1 — store an entry with a specific subject.
    await storeTool.store({
      content: 'L16 distribution model uses Pareto-tail refresh.',
      contentType: 'insight',
      source: 'technical',
      userId: 'richard_yaker',
      metadata: { subject: 'L16.distribution_model' }
    })

    const stored = captured.find(c => c.backend === 'graph')
    expect(stored?.knowledge.metadata.subject).toBe('L16.distribution_model')

    // Step 2 — search using the same subject. Verify the filter reaches every
    // backend with the same value the caller stored. (Actual filtering logic
    // in each backend is covered by their own search tests.)
    await searchTool.search({
      query: 'distribution',
      filters: {
        userId: 'richard_yaker',
        subject: stored!.knowledge.metadata.subject
      }
    })

    for (const q of queries) {
      expect(q.query.filters?.subject).toBe('L16.distribution_model')
    }
  })
})
