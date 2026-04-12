/**
 * Unit tests for UnifiedStoreTool corrective operations:
 * update, delete, flag, supersede, reap.
 *
 * These tests use mocked storage backends to verify the unified routing
 * layer correctly fans out to (and rolls back from) the right backends
 * without depending on real Mongo/SparrowDB/Mem0 instances.
 */

import { UnifiedStoreTool } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'

describe('UnifiedStoreTool — corrective operations', () => {
  let mongo: any
  let graph: any  // SparrowDB-shaped mock
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
      listFlagged: jest.fn().mockResolvedValue([])
    }

    graph = {
      name: 'sparrowdb',
      store: jest.fn().mockResolvedValue(undefined),
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
        primary: 'neo4j',
        secondary: ['mongodb', 'mem0'],
        cacheStrategy: 'L3',
        reasoning: 'test'
      }),
      getRoutingStats: jest.fn().mockReturnValue({})
    } as unknown as IntelligentStorageRouter

    tool = new UnifiedStoreTool(
      router,
      { mongodb: mongo, neo4j: graph, mem0 },
      cache,
      null,
      null
    )
  })

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  describe('update', () => {
    it('calls SparrowDB and MongoDB update with merged fields and audit reason', async () => {
      const result = await tool.update({
        id: 'abc-123',
        content: 'corrected content',
        reason: 'fix typo'
      })

      expect(graph.update).toHaveBeenCalledWith('abc-123', expect.objectContaining({
        content: 'corrected content',
        metadata: expect.objectContaining({
          update_history: expect.arrayContaining([
            expect.objectContaining({ reason: 'fix typo' })
          ])
        })
      }))
      expect(mongo.update).toHaveBeenCalledWith('abc-123', expect.objectContaining({
        content: 'corrected content'
      }))
      expect(result.success).toBe(true)
      expect(result.backends).toEqual(expect.arrayContaining(['sparrowdb', 'mongodb']))
    })

    it('does NOT call Mem0 (Mem0 is LLM-managed)', async () => {
      await tool.update({ id: 'abc-123', content: 'x', reason: 'test' })
      expect(mem0.deleteMemory).not.toHaveBeenCalled()
    })

    it('returns success=false if both backends fail', async () => {
      graph.update = jest.fn().mockResolvedValue(false)
      mongo.update = jest.fn().mockResolvedValue(false)
      const result = await tool.update({ id: 'nope', reason: 'test' })
      expect(result.success).toBe(false)
      expect(result.backends).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // delete (soft delete = flag DELETED)
  // -------------------------------------------------------------------------

  describe('delete', () => {
    it('flags entry as DELETED across all backends', async () => {
      const result = await tool.delete({ id: 'abc-123', reason: 'noise' })
      expect(graph.flag).toHaveBeenCalledWith('abc-123', 'DELETED', 'noise', undefined, undefined)
      expect(mongo.flag).toHaveBeenCalledWith('abc-123', 'DELETED', 'noise', undefined, undefined)
      expect(mem0.deleteMemory).toHaveBeenCalledWith('abc-123')
      expect(result.success).toBe(true)
      expect(result.flag).toBe('DELETED')
    })

    it('invalidates the search cache namespace', async () => {
      await tool.delete({ id: 'abc-123', reason: 'noise' })
      expect(cache.invalidate).toHaveBeenCalledWith('kms:search:*')
    })
  })

  // -------------------------------------------------------------------------
  // flag
  // -------------------------------------------------------------------------

  describe('flag', () => {
    it('marks entry with arbitrary flag', async () => {
      const result = await tool.flag({
        id: 'abc-123',
        flag: 'RETRACTED',
        note: 'partially wrong'
      })
      expect(graph.flag).toHaveBeenCalledWith('abc-123', 'RETRACTED', 'partially wrong', undefined, undefined)
      expect(mongo.flag).toHaveBeenCalledWith('abc-123', 'RETRACTED', 'partially wrong', undefined, undefined)
      expect(result.success).toBe(true)
      expect(result.flag).toBe('RETRACTED')
    })

    it('clears flag when flag=null and does NOT delete from Mem0', async () => {
      const result = await tool.flag({ id: 'abc-123', flag: null })
      expect(mem0.deleteMemory).not.toHaveBeenCalled()
      expect(result.flag).toBeNull()
    })

    it('passes superseded_by to backends when set', async () => {
      await tool.flag({
        id: 'old-id',
        flag: 'SUPERSEDED',
        note: 'see new-id',
        superseded_by: 'new-id'
      })
      expect(graph.flag).toHaveBeenCalledWith('old-id', 'SUPERSEDED', 'see new-id', undefined, 'new-id')
      expect(mongo.flag).toHaveBeenCalledWith('old-id', 'SUPERSEDED', 'see new-id', undefined, 'new-id')
    })
  })

  // -------------------------------------------------------------------------
  // supersede (atomic)
  // -------------------------------------------------------------------------

  describe('supersede', () => {
    it('stores new entry then flags old entry as SUPERSEDED with back-link', async () => {
      const result = await tool.supersede({
        old_id: 'old-id',
        new_content: 'corrected fact',
        reason: 'wrong calibration config'
      })

      expect(result.success).toBe(true)
      expect(result.old_id).toBe('old-id')
      expect(result.new_id).toBeDefined()

      // Verify old was flagged with the new ID as superseded_by
      expect(graph.flag).toHaveBeenCalledWith(
        'old-id',
        'SUPERSEDED',
        expect.stringContaining('wrong calibration config'),
        undefined,
        result.new_id
      )
    })

    it('rolls back the new entry if flagging the old one fails', async () => {
      // Make flag fail (entry not found)
      graph.flag = jest.fn().mockResolvedValue(false)
      mongo.flag = jest.fn().mockResolvedValue(false)

      const result = await tool.supersede({
        old_id: 'missing-id',
        new_content: 'replacement',
        reason: 'test rollback'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')

      // Rollback should have hard-deleted the new entry from all 3 backends
      expect(graph.delete).toHaveBeenCalled()
      expect(mongo.delete).toHaveBeenCalled()
      expect(mem0.deleteMemory).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // reap
  // -------------------------------------------------------------------------

  describe('reap', () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)   // 100 days ago
    const recentDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago

    beforeEach(() => {
      // SparrowDB returns one old + one recent flagged entry
      graph.listFlagged = jest.fn().mockReturnValue([
        { id: 'old-flag', flag: 'DELETED', flag_date: oldDate.toISOString(), flag_note: 'noise' },
        { id: 'recent-flag', flag: 'SUPERSEDED', flag_date: recentDate.toISOString() }
      ])
      // MongoDB returns the same old entry (will dedupe by ID)
      mongo.listFlagged = jest.fn().mockResolvedValue([
        { id: 'old-flag', flag: 'DELETED', flag_date: oldDate, flag_note: 'noise' }
      ])
    })

    it('dry-run lists candidates without deleting', async () => {
      const result = await tool.reap({})
      expect(result.dryRun).toBe(true)
      expect(result.candidates).toHaveLength(1)  // only the old one (recent is filtered by cutoff)
      expect(result.candidates[0].id).toBe('old-flag')
      expect(result.candidates[0].backends_found).toEqual(expect.arrayContaining(['sparrowdb', 'mongodb']))
      expect(graph.delete).not.toHaveBeenCalled()
      expect(mongo.delete).not.toHaveBeenCalled()
      expect(result.deleted).toBeUndefined()
    })

    it('apply mode hard-deletes from all backends', async () => {
      const result = await tool.reap({ dryRun: false })
      expect(result.dryRun).toBe(false)
      expect(graph.delete).toHaveBeenCalledWith('old-flag')
      expect(mongo.delete).toHaveBeenCalledWith('old-flag')
      expect(mem0.deleteMemory).toHaveBeenCalledWith('old-flag')
      expect(result.deleted).toHaveLength(1)
      expect(result.deleted![0].id).toBe('old-flag')
    })

    it('respects custom olderThanDays', async () => {
      // 7-day cutoff: both candidates are now older than 7 days
      const result = await tool.reap({ olderThanDays: 7 })
      expect(result.candidates).toHaveLength(2)
      expect(result.candidates.map(c => c.id).sort()).toEqual(['old-flag', 'recent-flag'])
    })
  })
})
