/**
 * DG-T0 — Tier 0 fingerprint dedup (prepend) integration tests.
 *
 * Verifies the UnifiedStoreTool.store() Tier 0 fingerprint check that
 * runs BEFORE the Tier 1 vector similarity check:
 *   1. Identical content → exact-band refuse (Tier 0 hit)
 *   2. Whitespace-only differences → still hit (normalize() works)
 *   3. Different userId → no Tier 0 hit; falls through to Tier 1
 *   4. Different contentType → no Tier 0 hit
 *   5. Same content + same subject → Tier 0 hit
 *   6. Same content + different subject → no Tier 0 hit
 *   7. New writes get a fingerprint stamped into metadata
 *   8. Tier 0 short-circuits BEFORE the embedder is called
 *   9. Flagged matches don't trigger Tier 0 (deleted/superseded entries)
 *  10. options.skip_dedup bypasses Tier 0
 *  11. action field bypasses Tier 0 (DG-T1-C dispatch)
 *  12. Older backends without findByFingerprint → Tier 0 inert
 *  13. computeFingerprint determinism + tuple separation properties
 *  14. normalize() drops trailing whitespace per line and collapses runs
 */

import { UnifiedStoreTool, type UnifiedStoreResult, type DedupRequiredResponse } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'
import { computeFingerprint, normalize } from '../dedup/Fingerprint.js'

function isDedupRequired(r: UnifiedStoreResult): r is DedupRequiredResponse {
  return (r as any).status === 'dedup_required'
}

describe('DG-T0 — Fingerprint module (computeFingerprint / normalize)', () => {
  describe('normalize()', () => {
    it('strips trailing whitespace per line', () => {
      expect(normalize('hello   \nworld   ')).toBe('hello\nworld')
    })

    it('collapses runs of horizontal whitespace within a line', () => {
      expect(normalize('foo    bar\t\tbaz')).toBe('foo bar baz')
    })

    it('preserves internal blank lines (paragraph structure)', () => {
      expect(normalize('para 1\n\npara 2')).toBe('para 1\n\npara 2')
    })

    it('drops leading and trailing blank lines from the whole content', () => {
      expect(normalize('\n\nhello\n\n')).toBe('hello')
    })

    it('normalizes CRLF / CR line endings to LF', () => {
      expect(normalize('a\r\nb\rc')).toBe('a\nb\nc')
    })

    it('returns empty string for empty / non-string input', () => {
      expect(normalize('')).toBe('')
      expect(normalize(undefined as any)).toBe('')
      expect(normalize(null as any)).toBe('')
    })
  })

  describe('computeFingerprint()', () => {
    it('produces a deterministic 64-char hex SHA-256', () => {
      const fp = computeFingerprint({
        content: 'hello world',
        userId: 'u',
        contentType: 'fact'
      })
      expect(fp).toMatch(/^[0-9a-f]{64}$/)
    })

    it('returns the same fingerprint for identical inputs', () => {
      const a = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact' })
      const b = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact' })
      expect(a).toBe(b)
    })

    it('returns the same fingerprint for whitespace-equivalent inputs', () => {
      const a = computeFingerprint({ content: 'foo bar', userId: 'u', contentType: 'fact' })
      const b = computeFingerprint({ content: '  foo    bar  \t', userId: 'u', contentType: 'fact' })
      expect(a).toBe(b)
    })

    it('changes when userId differs', () => {
      const a = computeFingerprint({ content: 'x', userId: 'u1', contentType: 'fact' })
      const b = computeFingerprint({ content: 'x', userId: 'u2', contentType: 'fact' })
      expect(a).not.toBe(b)
    })

    it('changes when contentType differs', () => {
      const a = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact' })
      const b = computeFingerprint({ content: 'x', userId: 'u', contentType: 'insight' })
      expect(a).not.toBe(b)
    })

    it('changes when subject differs', () => {
      const a = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact', subject: 'A' })
      const b = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact', subject: 'B' })
      expect(a).not.toBe(b)
    })

    it('treats omitted subject as empty string (deterministic absence)', () => {
      const omitted = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact' })
      const explicitEmpty = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact', subject: '' })
      expect(omitted).toBe(explicitEmpty)
    })

    it('treats "no subject" as a distinct scope from a real subject', () => {
      const noSubject = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact' })
      const withSubject = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact', subject: 'A' })
      expect(noSubject).not.toBe(withSubject)
    })

    it('cannot be confused by tuple-element separator collisions', () => {
      // If we had used a string separator like ":" naive concatenation could
      // collide. JSON.stringify on an array gives canonical separation.
      const a = computeFingerprint({ content: 'foo', userId: 'bar:baz', contentType: 'fact' })
      const b = computeFingerprint({ content: 'foo:bar', userId: 'baz', contentType: 'fact' })
      expect(a).not.toBe(b)
    })
  })
})

describe('DG-T0 — UnifiedStoreTool Tier 0 dedup gate', () => {
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
      listFlagged: jest.fn().mockResolvedValue([])
    }

    // Default graph mock: no Tier 0 match, no Tier 1 candidates.
    graph = {
      name: 'sparrowdb',
      store: jest.fn().mockResolvedValue(undefined),
      storeEmbedding: jest.fn().mockResolvedValue(true),
      findSimilar: jest.fn().mockResolvedValue([]),
      findByFingerprint: jest.fn().mockReturnValue(null),
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
  // 1. Identical content → exact-band refuse
  // -------------------------------------------------------------------------

  it('refuses identical content with band="exact" (Tier 0 hit)', async () => {
    const matchingEntry = {
      id: 'existing-fp-id',
      content: 'Phoenix camera count is 6',
      contentType: 'fact',
      source: 'technical',
      userId: 'u',
      timestamp: '2026-04-01T00:00:00Z',
      flag: null,
      metadata: { fingerprint: 'whatever' }
    }
    ;(graph as any).findByFingerprint = jest.fn().mockReturnValue(matchingEntry)

    const tool = makeTool()
    const result = await tool.store({
      content: 'Phoenix camera count is 6',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    expect(result.band).toBe('exact')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].id).toBe('existing-fp-id')
    expect(result.candidates[0].similarity).toBe(1.0)
    expect(result.candidates[0].llm_relation).toBe('duplicate')
    expect(result.message).toMatch(/Tier 0|fingerprint/i)
    expect(result.retry_with).toEqual(
      expect.arrayContaining([
        expect.stringContaining('action=supersede'),
        expect.stringContaining('action=update'),
        expect.stringContaining('action=complement'),
        expect.stringContaining('action=force-new')
      ])
    )

    // Critical: storage fan-out NEVER called when gate refuses
    expect(graph.store).not.toHaveBeenCalled()
    expect(mongo.store).not.toHaveBeenCalled()
    expect(mem0.store).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 2. Whitespace-only differences still trigger Tier 0
  // -------------------------------------------------------------------------

  it('catches whitespace-only differences (normalize() collapses them)', async () => {
    // The fingerprint for the original write
    const fpOriginal = computeFingerprint({
      content: 'foo bar baz',
      userId: 'u',
      contentType: 'fact'
    })
    const fpWhitespaceVariant = computeFingerprint({
      content: '  foo    bar\t\tbaz  ',
      userId: 'u',
      contentType: 'fact'
    })
    expect(fpOriginal).toBe(fpWhitespaceVariant)  // sanity: normalize equates them

    // Mock: when the gate looks up the whitespace-variant fingerprint, it
    // finds the original entry (because they share a fingerprint).
    ;(graph as any).findByFingerprint = jest.fn().mockImplementation(
      (fp: string, _userId: string) => {
        if (fp === fpOriginal) {
          return {
            id: 'original-id',
            content: 'foo bar baz',
            contentType: 'fact',
            source: 'technical',
            userId: 'u',
            timestamp: '2026-04-01T00:00:00Z',
            flag: null,
            metadata: { fingerprint: fpOriginal }
          }
        }
        return null
      }
    )

    const tool = makeTool()
    // Now write with extra whitespace. Should hit Tier 0.
    const result = await tool.store({
      content: '  foo    bar\t\tbaz  ',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(result.band).toBe('exact')
    expect(result.candidates[0].id).toBe('original-id')
  })

  // -------------------------------------------------------------------------
  // 3. Different userId → no Tier 0 hit; falls through to Tier 1
  // -------------------------------------------------------------------------

  it('does not hit Tier 0 across different userIds (falls through)', async () => {
    // Mock findByFingerprint to scope by userId (this is what real impl does).
    ;(graph as any).findByFingerprint = jest.fn().mockReturnValue(null)
    // Tier 1 returns nothing either, so the write should succeed.
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([])

    const tool = makeTool()
    const result = await tool.store({
      content: 'shared content',
      contentType: 'fact',
      userId: 'user_b'  // different from any pre-existing
    })

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    // Tier 1 ran (because Tier 0 didn't refuse)
    expect((graph as any).findSimilar).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 4. Different contentType → no Tier 0 hit (different fingerprint)
  // -------------------------------------------------------------------------

  it('produces different fingerprints for different contentTypes', async () => {
    let observedFingerprint: string | null = null
    ;(graph as any).findByFingerprint = jest.fn().mockImplementation((fp: string) => {
      observedFingerprint = fp
      return null  // no Tier 0 match
    })

    const tool = makeTool()
    await tool.store({
      content: 'x',
      contentType: 'insight',
      userId: 'u'
    })

    const fpFact = computeFingerprint({ content: 'x', userId: 'u', contentType: 'fact' })
    const fpInsight = computeFingerprint({ content: 'x', userId: 'u', contentType: 'insight' })
    expect(observedFingerprint).toBe(fpInsight)
    expect(observedFingerprint).not.toBe(fpFact)
  })

  // -------------------------------------------------------------------------
  // 5. Same content + same subject → Tier 0 hit
  // -------------------------------------------------------------------------

  it('hits Tier 0 when content + subject match', async () => {
    const fp = computeFingerprint({
      content: 'X',
      userId: 'u',
      contentType: 'fact',
      subject: 'Phoenix.cam'
    })
    ;(graph as any).findByFingerprint = jest.fn().mockImplementation((reqFp: string, uid: string) => {
      if (reqFp === fp && uid === 'u') {
        return {
          id: 'subject-tier0-match',
          content: 'X',
          contentType: 'fact',
          source: 'technical',
          userId: 'u',
          timestamp: '2026-04-01T00:00:00Z',
          flag: null,
          metadata: { fingerprint: fp, subject: 'Phoenix.cam' }
        }
      }
      return null
    })

    const tool = makeTool()
    const result = await tool.store({
      content: 'X',
      contentType: 'fact',
      userId: 'u',
      metadata: { subject: 'Phoenix.cam' }
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(result.band).toBe('exact')
    expect(result.candidates[0].id).toBe('subject-tier0-match')
    expect(result.candidates[0].subject).toBe('Phoenix.cam')
  })

  // -------------------------------------------------------------------------
  // 6. Same content + different subject → no Tier 0 hit
  // -------------------------------------------------------------------------

  it('does not hit Tier 0 when subject differs (different fingerprint scope)', async () => {
    let observedFingerprint: string | null = null
    ;(graph as any).findByFingerprint = jest.fn().mockImplementation((fp: string) => {
      observedFingerprint = fp
      return null
    })

    const tool = makeTool()
    await tool.store({
      content: 'X',
      contentType: 'fact',
      userId: 'u',
      metadata: { subject: 'Phoenix.cam' }
    })

    const fpA = computeFingerprint({
      content: 'X', userId: 'u', contentType: 'fact', subject: 'Phoenix.cam'
    })
    const fpB = computeFingerprint({
      content: 'X', userId: 'u', contentType: 'fact', subject: 'Phoenix.zoom'
    })
    expect(observedFingerprint).toBe(fpA)
    expect(observedFingerprint).not.toBe(fpB)
  })

  // -------------------------------------------------------------------------
  // 7. New writes get a fingerprint stamped into metadata
  // -------------------------------------------------------------------------

  it('stamps metadata.fingerprint on the stored entry', async () => {
    ;(graph as any).findByFingerprint = jest.fn().mockReturnValue(null)
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([])

    const tool = makeTool()
    const result = await tool.store({
      content: 'genuinely new content',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)

    // graph.store was called with the knowledge object — inspect its metadata.
    expect(graph.store).toHaveBeenCalledTimes(1)
    const stored = (graph.store as jest.Mock).mock.calls[0][0]
    expect(stored.metadata).toBeDefined()
    expect(typeof stored.metadata.fingerprint).toBe('string')
    expect(stored.metadata.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    // Sanity: it matches what computeFingerprint would produce.
    const expected = computeFingerprint({
      content: 'genuinely new content',
      userId: 'u',
      contentType: 'fact'
    })
    expect(stored.metadata.fingerprint).toBe(expected)
  })

  it('preserves the subject facet in the stamped fingerprint', async () => {
    ;(graph as any).findByFingerprint = jest.fn().mockReturnValue(null)

    const tool = makeTool()
    await tool.store({
      content: 'subject-tagged',
      contentType: 'fact',
      userId: 'u',
      metadata: { subject: 'Phoenix.cam' }
    })

    const stored = (graph.store as jest.Mock).mock.calls[0][0]
    const expected = computeFingerprint({
      content: 'subject-tagged',
      userId: 'u',
      contentType: 'fact',
      subject: 'Phoenix.cam'
    })
    expect(stored.metadata.fingerprint).toBe(expected)
    expect(stored.metadata.subject).toBe('Phoenix.cam')  // facet preserved
  })

  // -------------------------------------------------------------------------
  // 8. Tier 0 short-circuits BEFORE the embedder is called
  // -------------------------------------------------------------------------

  it('Tier 0 hit short-circuits before the embedder is called', async () => {
    ;(graph as any).findByFingerprint = jest.fn().mockReturnValue({
      id: 'tier0-hit',
      content: 'C',
      contentType: 'fact',
      source: 'technical',
      userId: 'u',
      timestamp: '2026-04-01T00:00:00Z',
      flag: null,
      metadata: {}
    })

    const tool = makeTool()
    const result = await tool.store({
      content: 'C',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(true)
    // Embedder never invoked — Tier 0 short-circuited.
    expect(embedder.embed).not.toHaveBeenCalled()
    // findSimilar (Tier 1) also never invoked.
    expect((graph as any).findSimilar).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 9. Flagged matches don't trigger Tier 0
  // -------------------------------------------------------------------------

  it('skips flagged Tier 0 matches (deleted/superseded entries do not block)', async () => {
    // Real impl filters out flagged entries internally. Here we simulate a
    // backend that returned the flagged entry (defensive: the gate itself
    // also checks `existing.flag` before refusing).
    ;(graph as any).findByFingerprint = jest.fn().mockReturnValue({
      id: 'flagged-old-entry',
      content: 'old content',
      contentType: 'fact',
      source: 'technical',
      userId: 'u',
      timestamp: '2026-04-01T00:00:00Z',
      flag: 'SUPERSEDED',  // gate must NOT refuse based on this
      metadata: {}
    })
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([])

    const tool = makeTool()
    const result = await tool.store({
      content: 'corrective rewrite',
      contentType: 'fact',
      userId: 'u'
    })

    // Tier 0 must NOT refuse — proceeds to Tier 1, which is also empty,
    // so the write succeeds.
    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 10. options.skip_dedup bypasses Tier 0
  // -------------------------------------------------------------------------

  it('options.skip_dedup=true bypasses Tier 0 entirely', async () => {
    const findByFingerprint = jest.fn().mockReturnValue({
      id: 'would-have-blocked',
      content: 'X',
      contentType: 'fact',
      source: 'technical',
      userId: 'u',
      timestamp: '2026-04-01T00:00:00Z',
      flag: null,
      metadata: {}
    })
    ;(graph as any).findByFingerprint = findByFingerprint

    const tool = makeTool()
    const result = await tool.store({
      content: 'X',
      contentType: 'fact',
      userId: 'u',
      options: { skip_dedup: true }
    } as any)

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    expect(findByFingerprint).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 11. action field bypasses Tier 0 (DG-T1-C dispatch)
  // -------------------------------------------------------------------------

  it('action=force-new bypasses Tier 0', async () => {
    const findByFingerprint = jest.fn().mockReturnValue({
      id: 'would-have-blocked',
      content: 'X',
      contentType: 'fact',
      source: 'technical',
      userId: 'u',
      timestamp: '2026-04-01T00:00:00Z',
      flag: null,
      metadata: {}
    })
    ;(graph as any).findByFingerprint = findByFingerprint

    const tool = makeTool()
    const result = await tool.store({
      content: 'X',
      contentType: 'fact',
      userId: 'u',
      action: 'force-new',
      reason: 'caller has explicit reason'
    } as any)

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    expect(findByFingerprint).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 12. Older backend without findByFingerprint → Tier 0 inert
  // -------------------------------------------------------------------------

  it('graph backend with no findByFingerprint method → Tier 0 inert (back-compat)', async () => {
    delete (graph as any).findByFingerprint

    const tool = makeTool()
    const result = await tool.store({
      content: 'older binding test',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    // Tier 1 still runs.
    expect((graph as any).findSimilar).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 13. findByFingerprint throw degrades to Tier 1 (non-fatal)
  // -------------------------------------------------------------------------

  it('findByFingerprint throw degrades to Tier 1 (non-fatal)', async () => {
    ;(graph as any).findByFingerprint = jest.fn().mockImplementation(() => {
      throw new Error('sidecar load failed')
    })
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([])

    const tool = makeTool()
    const result = await tool.store({
      content: 'tier 0 errored',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    // Tier 1 ran after Tier 0 failed.
    expect((graph as any).findSimilar).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 14. Tier 0 threads correct args to findByFingerprint
  // -------------------------------------------------------------------------

  it('threads (fingerprint, userId) into findByFingerprint', async () => {
    const findByFingerprint = jest.fn().mockReturnValue(null)
    ;(graph as any).findByFingerprint = findByFingerprint

    const tool = makeTool()
    await tool.store({
      content: 'precise inputs',
      contentType: 'insight',
      userId: 'richard_yaker',
      metadata: { subject: 'Phoenix.camera_count' }
    })

    expect(findByFingerprint).toHaveBeenCalledTimes(1)
    const [fp, uid] = findByFingerprint.mock.calls[0]
    expect(typeof fp).toBe('string')
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(uid).toBe('richard_yaker')
    // Sanity: matches what computeFingerprint produces for the same inputs.
    const expected = computeFingerprint({
      content: 'precise inputs',
      userId: 'richard_yaker',
      contentType: 'insight',
      subject: 'Phoenix.camera_count'
    })
    expect(fp).toBe(expected)
  })

  // -------------------------------------------------------------------------
  // 15. Tier 0 falls through to Tier 1 when no fingerprint match
  // -------------------------------------------------------------------------

  it('Tier 0 miss falls through to Tier 1 (existing dedup gate intact)', async () => {
    ;(graph as any).findByFingerprint = jest.fn().mockReturnValue(null)
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'tier1-near-dup',
        similarity: 0.92,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'similar but not byte-identical'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'this content is similar but whitespace differs from existing',
      contentType: 'fact',
      userId: 'u'
    })

    // Tier 1 refuse-band kicks in.
    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(result.band).toBe('refuse')
    expect(result.candidates[0].id).toBe('tier1-near-dup')
  })
})
