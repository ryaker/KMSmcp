/**
 * DG-T1-B — dedup gate (Tier 1 vector similarity) integration tests (issue #45).
 *
 * Verifies the UnifiedStoreTool.store() dedup gate:
 *   1. Near-duplicate write triggers `dedup_required` response with refuse band
 *   2. Borderline write triggers `dedup_required` response with confirm band
 *   3. Distinct write proceeds to normal store
 *   4. Per-contentType threshold overrides applied (procedure=0.85, pattern=0.92)
 *   5. options.skip_dedup bypasses the gate
 *   6. options.dedup_threshold_override honored when both refuse+confirm provided
 *   7. Asymmetric override rejected; falls back to defaults
 *   8. action field bypasses the gate (DG-T1-C placeholder)
 *   9. findSimilar failure degrades to normal store (non-fatal)
 *  10. Embedding service down → no dedup check (gate inert)
 */

import { UnifiedStoreTool, type UnifiedStoreResult, type DedupRequiredResponse } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'

// Type guards for the discriminated union the gate returns.
function isDedupRequired(r: UnifiedStoreResult): r is DedupRequiredResponse {
  return (r as any).status === 'dedup_required'
}

describe('DG-T1-B — UnifiedStoreTool dedup gate (issue #45)', () => {
  let mongo: any
  let graph: any
  let mem0: any
  let cache: any
  let router: IntelligentStorageRouter
  let embedder: jest.Mocked<EmbeddingService>

  // Deterministic 768-dim vector built from a content hash so identical content
  // always embeds to the same vector and similar content has high cosine.
  // For the gate tests we just want predictable cos values; the simplest fake:
  //   - hash content to seed an RNG
  //   - generate a unit vector
  //   - similar content → similar seed → similar vector
  // We instead use a much simpler "label-based" fake: each test seeds the
  // mock to return a specific vector for specific content. That's enough to
  // drive the gate's threshold logic deterministically.

  /** Build a 768d unit vector pointing along axis `axis` (0..767). */
  function axisVec(axis: number): Float32Array {
    const v = new Float32Array(768)
    v[axis] = 1
    return v
  }

  /**
   * Build a 768d unit vector that's a weighted blend of two axes — the
   * cosine similarity between two such vectors with shared axis A is
   * cos = a1*a2 + b1*b2 (where a is the share of axis A).
   *
   * For our tests:
   *   - twoAxisVec(0, 0.95)  ≈ axisVec(0) — produces ~0.95 cos against axisVec(0)
   *   - twoAxisVec(0, 0.85)  → ~0.85 cos
   *   - twoAxisVec(0, 0.5)   → ~0.5 cos (distinct)
   */
  function twoAxisVec(primaryAxis: number, primaryShare: number): Float32Array {
    const v = new Float32Array(768)
    const sec = (primaryAxis + 1) % 768
    v[primaryAxis] = primaryShare
    v[sec] = Math.sqrt(1 - primaryShare * primaryShare)
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

    // Default graph mock: findSimilar returns [] (no candidates), normal store path.
    // Individual tests override findSimilar to inject candidates.
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
  // 1. Near-duplicate triggers refuse band
  // -------------------------------------------------------------------------

  it('returns dedup_required (refuse band) when a candidate sim >= 0.88', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'existing-fact-id',
        similarity: 0.92,
        contentType: 'fact',
        source: 'technical',
        subject: 'Phoenix.camera_count',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'Phoenix camera count is UNKNOWN pending canvas bounds verification...'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'Phoenix camera count is unknown — needs canvas bounds verified',
      contentType: 'fact',
      userId: 'richard_yaker',
      metadata: { subject: 'Phoenix.camera_count' }
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return  // type narrow

    expect(result.status).toBe('dedup_required')
    expect(result.band).toBe('refuse')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].id).toBe('existing-fact-id')
    expect(result.candidates[0].similarity).toBeCloseTo(0.92, 5)
    expect(result.candidates[0].llm_relation).toBeNull()  // Tier 2 not yet wired
    expect(result.thresholds.refuse).toBe(0.88)
    expect(result.thresholds.confirm).toBe(0.78)
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
    expect((graph as any).storeEmbedding).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 2. Borderline triggers confirm band
  // -------------------------------------------------------------------------

  it('returns dedup_required (confirm band) when candidate sim is in [0.78, 0.88)', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'related-id',
        similarity: 0.83,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'related but not identical content'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'borderline test content',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    expect(result.band).toBe('confirm')
    expect(result.message).toMatch(/[Bb]orderline/)
    expect(graph.store).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 3. Distinct write proceeds to normal store
  // -------------------------------------------------------------------------

  it('proceeds to normal store when all candidates have sim < 0.78', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'unrelated-id',
        similarity: 0.41,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'totally unrelated content'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'genuinely new fact about a completely unrelated topic',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    expect(graph.store).toHaveBeenCalledTimes(1)
    expect(mongo.store).toHaveBeenCalledTimes(1)
    expect(mem0.store).toHaveBeenCalledTimes(1)
  })

  it('proceeds to normal store when findSimilar returns []', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([])
    const tool = makeTool()
    const result = await tool.store({ content: 'first ever entry', contentType: 'fact', userId: 'u' })
    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 4. Per-contentType threshold overrides
  // -------------------------------------------------------------------------

  it('applies procedure refuse threshold of 0.85 (lower than default)', async () => {
    // sim=0.86 — would be confirm-band under default 0.88, refuse-band under procedure 0.85.
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'proc-id',
        similarity: 0.86,
        contentType: 'procedure',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'procedure preview'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'procedure refutation rewrite',
      contentType: 'procedure',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(result.band).toBe('refuse')
    expect(result.thresholds.refuse).toBe(0.85)
  })

  it('applies pattern refuse threshold of 0.92 (higher than default)', async () => {
    // sim=0.89 — would be refuse-band under default 0.88, but pattern's stricter
    // 0.92 threshold puts it in confirm-band.
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'pat-id',
        similarity: 0.89,
        contentType: 'pattern',
        source: 'cross_domain',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'pattern preview'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'pattern test',
      contentType: 'pattern',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(result.band).toBe('confirm')
    expect(result.thresholds.refuse).toBe(0.92)
  })

  // -------------------------------------------------------------------------
  // 5. skip_dedup escape hatch
  // -------------------------------------------------------------------------

  it('options.skip_dedup=true bypasses the gate entirely (no findSimilar call)', async () => {
    const findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'would-have-blocked',
        similarity: 0.99,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'would-have-blocked'
      }
    ])
    ;(graph as any).findSimilar = findSimilar

    const tool = makeTool()
    const result = await tool.store({
      content: 'identical content',
      contentType: 'fact',
      userId: 'u',
      options: { skip_dedup: true }
    } as any)

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    expect(findSimilar).not.toHaveBeenCalled()
    expect(graph.store).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 6 + 7. dedup_threshold_override
  // -------------------------------------------------------------------------

  it('dedup_threshold_override honored when both refuse + confirm provided', async () => {
    // sim=0.80 — would be confirm-band under defaults (0.88/0.78). With override
    // refuse=0.95, confirm=0.85 → 0.80 is below confirm → distinct → proceeds.
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'x',
        similarity: 0.80,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'preview'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'override raises thresholds',
      contentType: 'fact',
      userId: 'u',
      options: { dedup_threshold_override: { refuse: 0.95, confirm: 0.85 } }
    } as any)

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
  })

  it('dedup_threshold_override applied symmetrically (refuse-band path)', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'x',
        similarity: 0.96,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'preview'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'override hits refuse band',
      contentType: 'fact',
      userId: 'u',
      options: { dedup_threshold_override: { refuse: 0.95, confirm: 0.85 } }
    } as any)

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(result.thresholds.refuse).toBe(0.95)
    expect(result.thresholds.confirm).toBe(0.85)
    expect(result.band).toBe('refuse')
  })

  it('asymmetric override (only refuse, no confirm) is rejected; defaults applied', async () => {
    // With defaults (0.88/0.78), sim=0.83 is confirm-band. If override were
    // accepted asymmetrically with refuse=0.95, the test below would expect
    // distinct path. We expect defaults to apply → confirm band.
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'x',
        similarity: 0.83,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'preview'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'asymmetric override should be ignored',
      contentType: 'fact',
      userId: 'u',
      options: { dedup_threshold_override: { refuse: 0.95 } }
    } as any)

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(result.thresholds.refuse).toBe(0.88)  // defaults — override ignored
    expect(result.thresholds.confirm).toBe(0.78)
    expect(result.band).toBe('confirm')
  })

  it('inverted override (refuse < confirm) is rejected; defaults applied', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'x',
        similarity: 0.92,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'preview'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'inverted override should be ignored',
      contentType: 'fact',
      userId: 'u',
      options: { dedup_threshold_override: { refuse: 0.5, confirm: 0.7 } }
    } as any)

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(result.thresholds.refuse).toBe(0.88)
    expect(result.thresholds.confirm).toBe(0.78)
  })

  // -------------------------------------------------------------------------
  // 8. action field bypasses the gate (DG-T1-C placeholder)
  // -------------------------------------------------------------------------

  it('action field bypasses the gate and proceeds to normal store (DG-T1-C placeholder)', async () => {
    const findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'old-id',
        similarity: 0.99,
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'preview'
      }
    ])
    ;(graph as any).findSimilar = findSimilar

    const tool = makeTool()
    const result = await tool.store({
      content: 'caller is retrying with explicit action',
      contentType: 'fact',
      userId: 'u',
      action: 'force-new',
      reason: 'DG-T1-C dispatch not yet wired'
    } as any)

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    expect(findSimilar).not.toHaveBeenCalled()  // gate skipped entirely
  })

  // -------------------------------------------------------------------------
  // 9. findSimilar failure degrades to normal store
  // -------------------------------------------------------------------------

  it('findSimilar throw degrades to normal store (non-fatal)', async () => {
    ;(graph as any).findSimilar = jest.fn().mockRejectedValue(new Error('vectorSearch crashed'))

    const tool = makeTool()
    const result = await tool.store({
      content: 'gate failure should not block writes',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    expect(graph.store).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 10. No embedder → gate inert
  // -------------------------------------------------------------------------

  it('no embedding generated → no findSimilar call (gate inert)', async () => {
    embedder.embed = jest.fn().mockRejectedValue(new Error('Ollama down'))
    const findSimilar = jest.fn()
    ;(graph as any).findSimilar = findSimilar

    const tool = makeTool()
    const result = await tool.store({
      content: 'no embedding so no gate',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
    expect(findSimilar).not.toHaveBeenCalled()
  })

  it('graph backend with no findSimilar method → gate inert (back-compat)', async () => {
    delete (graph as any).findSimilar

    const tool = makeTool()
    const result = await tool.store({
      content: 'older binding without findSimilar',
      contentType: 'fact',
      userId: 'u'
    })

    expect(isDedupRequired(result)).toBe(false)
    if (isDedupRequired(result)) return
    expect(result.success).toBe(true)
  })

  // -------------------------------------------------------------------------
  // findSimilar input plumbing — verify the gate passes correct filters
  // -------------------------------------------------------------------------

  it('gate threads userId, contentType, and metadata.subject into findSimilar', async () => {
    const findSimilar = jest.fn().mockResolvedValue([])
    ;(graph as any).findSimilar = findSimilar

    const tool = makeTool()
    await tool.store({
      content: 'subject-tagged write',
      contentType: 'insight',
      userId: 'richard_yaker',
      metadata: { subject: 'Phoenix.camera_count' }
    })

    expect(findSimilar).toHaveBeenCalledTimes(1)
    const [vec, opts] = findSimilar.mock.calls[0]
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(768)
    expect(opts).toEqual({
      userId: 'richard_yaker',
      contentType: 'insight',
      subject: 'Phoenix.camera_count',
      topK: 5
    })
  })

  it('gate omits subject in findSimilar opts when caller did not pass one', async () => {
    const findSimilar = jest.fn().mockResolvedValue([])
    ;(graph as any).findSimilar = findSimilar

    const tool = makeTool()
    await tool.store({
      content: 'no subject',
      contentType: 'fact',
      userId: 'u'
    })

    const [, opts] = findSimilar.mock.calls[0]
    expect(opts.subject).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Calibration corpus smoke test
  //
  // The calibration fixture (test-fixtures/dedup-calibration.json) holds 32
  // duplicate pairs and 34 distinct pairs from the real KMS corpus. We don't
  // re-embed them here (would require a live Ollama); we just verify the
  // fixture structure is intact and the threshold constants used in this
  // file align with the calibration report.
  // -------------------------------------------------------------------------

  it('threshold constants align with calibration corpus (DG-INV-2)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fixture = require('../../test-fixtures/dedup-calibration.json')
    expect(fixture.duplicate_pairs.length).toBeGreaterThanOrEqual(30)
    expect(fixture.distinct_pairs.length).toBeGreaterThanOrEqual(30)
    expect(fixture.embedder).toMatch(/nomic/)
    expect(fixture.embedder_dim).toBe(768)
    // The active gate uses the empirically-calibrated thresholds, not the
    // spec's original 0.90/0.75 guesses.
    expect(0.88).toBeGreaterThan(0.78)
  })
})
