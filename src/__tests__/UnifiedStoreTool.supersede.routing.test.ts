/**
 * Routing-aware supersede tests (issue #62).
 *
 * The storage router writes to graph + mem0 always, but only adds MongoDB
 * for procedure / source=technical / MONGODB_PATTERN content. Before the
 * fix, supersede() unconditionally required MongoDB.flag success and
 * silently rolled back for entries that never landed in MongoDB — DG-INV-2
 * found 4 historical orphan supersede chains from this bug.
 *
 * The fix is option (b): query-first, flag-where-found. Each supersede call
 * probes graph.findById and mongodb.findById, builds the set of backends
 * where the entry actually lives (`requiredBackends`), then succeeds only
 * if all required backends flagged successfully. Backends that don't have
 * the entry are skipped, not failed.
 *
 * These tests verify the fix without depending on real backends.
 */

import { UnifiedStoreTool } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'

describe('UnifiedStoreTool.supersede — routing-aware backend selection', () => {
  let mongo: any
  let graph: any
  let mem0: any
  let cache: any
  let router: IntelligentStorageRouter
  let tool: UnifiedStoreTool

  beforeEach(() => {
    mongo = {
      store: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      listFlagged: jest.fn().mockResolvedValue([]),
      // Default: entry NOT in MongoDB. Tests override per scenario.
      findById: jest.fn().mockResolvedValue(null)
    }

    graph = {
      name: 'sparrowdb',
      store: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
      flag: jest.fn().mockResolvedValue(true),
      // Default: entry NOT in graph. Tests override per scenario.
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
        // mem0 only — simulates the common cross_domain/insight routing
        secondary: ['mem0'],
        cacheStrategy: 'L3',
        reasoning: 'graph + mem0 (no MongoDB) — typical insight/cross_domain'
      }),
      getRoutingStats: jest.fn().mockReturnValue({})
    } as unknown as IntelligentStorageRouter

    tool = new UnifiedStoreTool(
      router,
      { mongodb: mongo, graph, mem0 },
      cache,
      null,
      null
    )
  })

  describe('graph + mem0 only (no MongoDB) — issue #62 primary repro', () => {
    beforeEach(() => {
      // Entry routed to graph + mem0 only. Mongo.findById returns null.
      graph.findById = jest.fn().mockReturnValue({
        id: 'graph-only-id',
        content: 'cross-domain insight',
        contentType: 'insight',
        source: 'cross_domain'
      })
      mongo.findById = jest.fn().mockResolvedValue(null)
    })

    it('succeeds without requiring MongoDB.flag', async () => {
      const result = await tool.supersede({
        old_id: 'graph-only-id',
        new_content: 'corrected cross-domain insight',
        contentType: 'insight',
        source: 'cross_domain',
        reason: 'fix from #62 repro'
      })

      expect(result.success).toBe(true)
      expect(result.new_id).toBeDefined()
      expect(result.backends).toEqual(['sparrowdb'])

      // Graph was flagged — that's the only required backend
      expect(graph.flag).toHaveBeenCalledWith(
        'graph-only-id',
        'SUPERSEDED',
        expect.stringContaining('fix from #62 repro'),
        undefined,
        result.new_id
      )

      // MongoDB flag MUST NOT be called — entry doesn't live there
      expect(mongo.flag).not.toHaveBeenCalled()

      // No rollback should have fired
      expect(graph.delete).not.toHaveBeenCalled()
      expect(mongo.delete).not.toHaveBeenCalled()
    })

    it('rolls back if the only required backend (graph) fails to flag', async () => {
      graph.flag = jest.fn().mockResolvedValue(false)

      const result = await tool.supersede({
        old_id: 'graph-only-id',
        new_content: 'replacement',
        reason: 'test rollback on graph-only'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('sparrowdb')
      // mongodb should NOT appear in the failed-backends list (we never tried it)
      expect(result.error).not.toContain('mongodb')

      // Rollback hard-deletes the new entry across all backends
      expect(graph.delete).toHaveBeenCalled()
      expect(mongo.delete).toHaveBeenCalled()
      expect(mem0.deleteMemory).toHaveBeenCalled()
    })
  })

  describe('all three backends (procedure / technical entry)', () => {
    beforeEach(() => {
      graph.findById = jest.fn().mockReturnValue({ id: 'all-id', content: 'config snippet' })
      mongo.findById = jest.fn().mockResolvedValue({ id: 'all-id', content: 'config snippet' })
    })

    it('flags all required backends and succeeds when both flag OK', async () => {
      const result = await tool.supersede({
        old_id: 'all-id',
        new_content: 'updated config snippet',
        contentType: 'procedure',
        source: 'technical',
        reason: 'config drift'
      })

      expect(result.success).toBe(true)
      expect(result.backends).toEqual(expect.arrayContaining(['sparrowdb', 'mongodb']))
      expect(graph.flag).toHaveBeenCalled()
      expect(mongo.flag).toHaveBeenCalled()
    })

    it('rolls back if either of the two required backends fails', async () => {
      mongo.flag = jest.fn().mockResolvedValue(false)

      const result = await tool.supersede({
        old_id: 'all-id',
        new_content: 'updated',
        reason: 'test partial mongo failure'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('mongodb')

      // The graph flag that succeeded should be reversed
      expect(graph.flag).toHaveBeenCalledWith('all-id', null)

      // New entry deleted from all backends
      expect(graph.delete).toHaveBeenCalled()
      expect(mongo.delete).toHaveBeenCalled()
    })
  })

  describe('mongo-only (rare — programmatic insert that skipped graph)', () => {
    beforeEach(() => {
      graph.findById = jest.fn().mockReturnValue(null)
      mongo.findById = jest.fn().mockResolvedValue({ id: 'mongo-only-id', content: 'orphan' })
    })

    it('succeeds by flagging only MongoDB', async () => {
      const result = await tool.supersede({
        old_id: 'mongo-only-id',
        new_content: 'replacement',
        reason: 'mongo-only entry'
      })

      expect(result.success).toBe(true)
      expect(result.backends).toEqual(['mongodb'])
      expect(graph.flag).not.toHaveBeenCalled()
      expect(mongo.flag).toHaveBeenCalled()
    })
  })

  describe('not in any backend — error path', () => {
    beforeEach(() => {
      graph.findById = jest.fn().mockReturnValue(null)
      mongo.findById = jest.fn().mockResolvedValue(null)
    })

    it('returns clear error and does not store the new entry or flag anything', async () => {
      const result = await tool.supersede({
        old_id: 'ghost-id',
        new_content: 'orphan replacement',
        reason: 'wrong id'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found in any backend')

      // Fail-fast: nothing else fired
      expect(graph.store).not.toHaveBeenCalled()
      expect(mongo.store).not.toHaveBeenCalled()
      expect(mem0.store).not.toHaveBeenCalled()
      expect(graph.flag).not.toHaveBeenCalled()
      expect(mongo.flag).not.toHaveBeenCalled()
      expect(graph.delete).not.toHaveBeenCalled()
      expect(mongo.delete).not.toHaveBeenCalled()
    })
  })

  describe('backend probe errors are non-fatal (treated as not-present)', () => {
    it('treats graph.findById error as not-present and continues with mongo if mongo has it', async () => {
      graph.findById = jest.fn().mockImplementation(() => { throw new Error('sparrowdb down') })
      mongo.findById = jest.fn().mockResolvedValue({ id: 'mongo-only-id', content: 'in mongo' })

      const result = await tool.supersede({
        old_id: 'mongo-only-id',
        new_content: 'replacement',
        reason: 'graph probe flaky'
      })

      // Should succeed via mongo since it's the only "required" backend the
      // probe identified. graph.flag should NOT be called (probe errored).
      expect(result.success).toBe(true)
      expect(result.backends).toEqual(['mongodb'])
      expect(graph.flag).not.toHaveBeenCalled()
      expect(mongo.flag).toHaveBeenCalled()
    })

    it('returns "not found" error when both probes fail', async () => {
      graph.findById = jest.fn().mockImplementation(() => { throw new Error('sparrowdb down') })
      mongo.findById = jest.fn().mockRejectedValue(new Error('mongo down'))

      const result = await tool.supersede({
        old_id: 'whatever',
        new_content: 'x',
        reason: 'both probes flaky'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found in any backend')
    })
  })
})
