/**
 * Review queue (review: 'candidate' + kms_review) and write-path secret scrubbing.
 *
 * Candidates are flagged at WRITE time, never via flag(): flag() drops Mem0
 * copies, which an approval could not bring back. Review may only act on
 * entries that are CANDIDATE — it must never resurrect SUPERSEDED/DELETED
 * entries. Scrubbing runs before any backend sees the content.
 */
import { UnifiedStoreTool } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'

const HEX64 = '6a16f0adcd9e745b7208aeaaa5633121f2c6db23a3b9b838789c4e0c44668fac'

function axisVec(): Float32Array {
  const v = new Float32Array(768)
  v[0] = 1
  return v
}

describe('UnifiedStoreTool — review queue + secret scrubbing', () => {
  let graph: any
  let mongodb: any
  let mem0: any
  let tool: UnifiedStoreTool

  beforeEach(() => {
    const router = {
      determineStorage: jest.fn().mockReturnValue({ primary: 'graph', secondary: [], cacheStrategy: 'L3', reasoning: 'test' }),
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
      listByFlag: jest.fn().mockReturnValue([]),
    } as unknown as GraphStorage
    mongodb = { store: jest.fn(), flag: jest.fn().mockResolvedValue(true) }
    mem0 = { store: jest.fn(), deleteMemory: jest.fn().mockResolvedValue(true) }
    const embedder = {
      embedderId: 'test', dimensions: 768,
      embed: jest.fn().mockResolvedValue(axisVec()),
      isAvailable: jest.fn().mockResolvedValue(true)
    } as unknown as EmbeddingService
    tool = new UnifiedStoreTool(
      router,
      { mongodb, graph, mem0 } as any,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn(), invalidate: jest.fn() } as any,
      null, null, embedder
    )
  })

  const stored = (): any => (graph.store as jest.Mock).mock.calls[0][0]

  describe('review: candidate', () => {
    it('stores the entry flagged CANDIDATE at write time, attributed to its provenance', async () => {
      await tool.store({
        content: 'Granola: team agreed to ship the V1 dashboard Friday',
        contentType: 'fact', source: 'personal', userId: 'eng_kms',
        metadata: { provenance: 'granola-importer' },
        review: 'candidate'
      } as any)
      expect(stored().flag).toBe('CANDIDATE')
      expect(stored().flag_by).toBe('granola-importer')
      // Written, not dropped: no flag() call, so Mem0 copies are never deleted.
      expect(graph.flag).not.toHaveBeenCalled()
      expect(mem0.deleteMemory).not.toHaveBeenCalled()
    })

    it('leaves deliberate stores unflagged', async () => {
      await tool.store({ content: 'Deliberate fact', contentType: 'fact', source: 'personal', userId: 'eng_kms' } as any)
      expect(stored().flag).toBeUndefined()
    })
  })

  describe('kms_review', () => {
    it('lists pending candidates from the graph', async () => {
      graph.listByFlag.mockReturnValue([{ id: 'c1' }, { id: 'c2' }])
      const r = await tool.review({ action: 'list', userId: 'eng_kms', limit: 10 })
      expect(graph.listByFlag).toHaveBeenCalledWith('CANDIDATE', { userId: 'eng_kms', limit: 10 })
      expect(r).toMatchObject({ success: true, pending: 2 })
    })

    it('approve clears the flag and never touches Mem0', async () => {
      graph.findById.mockReturnValue({ id: 'c1', flag: 'CANDIDATE' })
      const r = await tool.review({ action: 'approve', id: 'c1', reason: 'looks right' })
      expect(graph.flag).toHaveBeenCalledWith('c1', null, 'looks right', 'kms_review', undefined)
      expect(mem0.deleteMemory).not.toHaveBeenCalled()
      expect(r).toMatchObject({ success: true, action: 'approve', flag: null })
    })

    it('reject soft-deletes (DELETED, reversible)', async () => {
      graph.findById.mockReturnValue({ id: 'c1', flag: 'CANDIDATE' })
      const r = await tool.review({ action: 'reject', id: 'c1' })
      expect(graph.flag).toHaveBeenCalledWith('c1', 'DELETED', 'rejected in review', 'kms_review', undefined)
      expect(r).toMatchObject({ action: 'reject', flag: 'DELETED' })
    })

    it.each(['SUPERSEDED', 'DELETED', 'RETRACTED', null])('refuses to act on a %s entry', async (flag) => {
      graph.findById.mockReturnValue({ id: 'x', flag })
      const r = await tool.review({ action: 'approve', id: 'x' })
      expect(r.success).toBe(false)
      expect(graph.flag).not.toHaveBeenCalled()
    })

    it('reports a missing entry and a missing id', async () => {
      expect((await tool.review({ action: 'approve', id: 'nope' })).error).toBe('entry not found')
      expect((await tool.review({ action: 'reject' })).error).toBe('reject requires id')
    })
  })

  describe('secret scrubbing on write paths', () => {
    it('unified_store masks before the backend sees it and records redactions', async () => {
      await tool.store({
        content: `catalog download: curl "https://catalog.yaker.org/dl/1?token=${HEX64}"`,
        contentType: 'procedure', source: 'technical', userId: 'eng_kms'
      } as any)
      expect(stored().content).toContain('?token=[REDACTED:url_credential]')
      expect(stored().content).not.toContain(HEX64)
      expect(stored().metadata.redactions).toEqual([{ type: 'url_credential', count: 1 }])
    })

    it('kms_update masks new content before any backend update', async () => {
      graph.findById.mockReturnValue({ id: 'u1', content: 'old', contentType: 'fact', userId: 'eng_kms', metadata: {} })
      await tool.update({ id: 'u1', content: `DB_PASSWORD=${HEX64}`, reason: 'fix' })
      const sent = JSON.stringify((graph.update as jest.Mock).mock.calls)
      expect(sent).toContain('[REDACTED:env_secret]')
      expect(sent).not.toContain(HEX64)
    })

    it('kms_supersede masks new_content before storing the replacement', async () => {
      graph.findById.mockReturnValue({ id: 'old1', content: 'old', contentType: 'fact', userId: 'eng_kms', metadata: {} })
      await tool.supersede({
        old_id: 'old1', new_content: `Use header Authorization: Bearer ${HEX64}`,
        contentType: 'fact', userId: 'eng_kms', reason: 'rotated'
      })
      const sent = JSON.stringify((graph.store as jest.Mock).mock.calls)
      expect(sent).toContain('Bearer [REDACTED:bearer_token]')
      expect(sent).not.toContain(HEX64)
    })
  })
})
