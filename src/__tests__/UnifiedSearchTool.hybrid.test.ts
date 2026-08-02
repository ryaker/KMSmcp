/**
 * Hybrid (vector + lexical) retrieval in UnifiedSearchTool.search().
 *
 * The feature is gated on KMS_HYBRID_RETRIEVAL=1 and defaults OFF, because a ranking
 * change shipped on reasoning alone on 2026-08-01 measured WORSE and had to be reverted.
 * These tests pin both halves of that contract: with the flag off nothing about the read
 * path changes at all, and with it on the vector arm both adds recall and can actually
 * surface what it adds.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'

const FLAG = 'KMS_HYBRID_RETRIEVAL'

/** A vector hit as SparrowDBStorage.findSimilar returns it (preview, not full entry). */
const vectorHit = (over: Partial<Record<string, any>> = {}) => ({
  id: 'v1',
  similarity: 0.87,
  contentType: 'insight',
  source: 'personal',
  subject: undefined,
  created: '2026-01-01T00:00:00.000Z',
  flag: null,
  content_preview: 'preview',
  ...over,
})

const stubEmbedder = (over: Partial<EmbeddingService> = {}): jest.Mocked<EmbeddingService> => ({
  embedderId: 'stub-embed:v1',
  dimensions: 768,
  embed: jest.fn().mockResolvedValue(new Float32Array(768)),
  isAvailable: jest.fn().mockResolvedValue(true),
  ...over,
} as unknown as jest.Mocked<EmbeddingService>)

interface HarnessOpts {
  mem0?: any[]
  mongodb?: any[]
  graph?: any[]
  similar?: any[] | Error
  /** Omit findSimilar entirely, as an older/non-vector backend would. */
  withoutFindSimilar?: boolean
  /** Entries hydrateFromGraph() can resolve, keyed by id. */
  entries?: Record<string, any>
  embedder?: jest.Mocked<EmbeddingService> | null
}

const buildTool = (opts: HarnessOpts = {}) => {
  const findSimilar = jest.fn(async () => {
    if (opts.similar instanceof Error) throw opts.similar
    return opts.similar ?? []
  })

  const graph: any = {
    search: jest.fn().mockResolvedValue(opts.graph ?? []),
    getEntitySummary: jest.fn().mockResolvedValue(null),
    getOperationalNodes: jest.fn().mockResolvedValue([]),
    findById: jest.fn((id: string) => opts.entries?.[id] ?? null),
  }
  if (!opts.withoutFindSimilar) graph.findSimilar = findSimilar

  const mem0 = { search: jest.fn().mockResolvedValue(opts.mem0 ?? []) }
  const mongodb = { search: jest.fn().mockResolvedValue(opts.mongodb ?? []) }
  const embedder = opts.embedder === undefined ? stubEmbedder() : opts.embedder

  // Cache is null throughout: these tests are about retrieval, and a shared cache would
  // let one test's ordering leak into the next.
  const tool = new UnifiedSearchTool({ mongodb, graph, mem0 } as any, null, embedder)
  return { tool, graph, mem0, mongodb, findSimilar, embedder }
}

/**
 * Runs `fn` with KMS_EVAL_CAPTURE='1', then restores whatever the variable held
 * beforehand — absent if it was absent, or its prior value if some other test (or the
 * environment) had set one. An unconditional `delete` in the finally block would clobber
 * that prior value instead of restoring it, leaking state into whatever runs next.
 */
async function withEvalCapture<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.KMS_EVAL_CAPTURE
  process.env.KMS_EVAL_CAPTURE = '1'
  try {
    return await fn()
  } finally {
    if (original === undefined) delete process.env.KMS_EVAL_CAPTURE
    else process.env.KMS_EVAL_CAPTURE = original
  }
}

const QUERY = 'quarterly revenue forecast'

/** Lexically strong: contains every query term. */
const LEX_STRONG = {
  id: 'lex-strong',
  content: 'The quarterly revenue forecast was revised upward after the March close.',
  confidence: 1,
  timestamp: '2026-07-01T00:00:00.000Z',
  contentType: 'fact',
  metadata: {},
}

/** Lexically weak: shares one term. */
const LEX_WEAK = {
  id: 'lex-weak',
  content: 'Revenue recognition policy for hardware bundles.',
  confidence: 1,
  timestamp: '2026-06-01T00:00:00.000Z',
  contentType: 'fact',
  metadata: {},
}

/**
 * Zero term overlap with QUERY — no "quarterly", no "revenue", no "forecast".
 * Lexical relevance for this content is exactly 0, so under the shipped composite it can
 * never rank above anything. It is only reachable through the vector arm.
 */
const SEMANTIC_ONLY = {
  id: 'sem-only',
  content: 'Top-line projections for the next three months were rebuilt from the pipeline.',
  confidence: 1,
  timestamp: '2026-05-01T00:00:00.000Z',
  contentType: 'insight',
  source: 'personal',
  metadata: {},
}

describe('UnifiedSearchTool — hybrid retrieval', () => {
  const ORIGINAL = process.env[FLAG]
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FLAG]
    else process.env[FLAG] = ORIGINAL
  })

  // ── flag OFF: byte-identical to current main ───────────────────────────────

  describe('flag off (default)', () => {
    beforeEach(() => { delete process.env[FLAG] })

    it('never embeds and never touches the vector index', async () => {
      const { tool, findSimilar, embedder } = buildTool({
        mem0: [LEX_STRONG],
        similar: [vectorHit()],
      })
      await tool.search({ query: QUERY })

      expect(findSimilar).not.toHaveBeenCalled()
      expect(embedder!.embed).not.toHaveBeenCalled()
      expect(embedder!.isAvailable).not.toHaveBeenCalled()
    })

    it('emits no hybrid signals and no vector source count', async () => {
      const { tool } = buildTool({ mem0: [LEX_STRONG, LEX_WEAK], similar: [vectorHit()] })
      const res = await tool.search({ query: QUERY })

      expect(Object.keys(res.sources)).toEqual(['mem0', 'graph', 'mongodb'])
      expect(res.sources.vector).toBeUndefined()
      expect((res as any)._hybridRetrieval).toBeUndefined()

      for (const r of res.results) {
        for (const field of ['_rrf', '_lexicalRank', '_vectorRank', '_vectorSimilarity', '_lexicalScore']) {
          expect(field in r).toBe(false)
        }
      }
    })

    it('keeps _score as the lexical composite (relevance*0.70 + recency*0.25 + confidence*0.05)', async () => {
      const { tool } = buildTool({ mem0: [LEX_STRONG] })
      const res = await tool.search({ query: QUERY })
      const r = res.results[0]

      expect(r._score).toBeCloseTo(r._relevance * 0.70 + r._recency * 0.25 + 1 * 0.05, 4)
      // Firmly in lexical-composite territory, nowhere near an RRF magnitude (~0.016).
      expect(r._score).toBeGreaterThan(0.3)
    })

    it('captures the same eval fields it captured before this change', async () => {
      await withEvalCapture(async () => {
        const { tool } = buildTool({ mem0: [LEX_STRONG], similar: [vectorHit()] })
        const res = await tool.search({ query: QUERY })
        const candidate = res._evalCapture!.candidates[0]
        expect(Object.keys(candidate).sort()).toEqual([
          '_recency', '_relevance', '_score', '_sourceSystems',
          'confidence', 'content', 'contentType', 'extractedBy', 'id',
          'sourceSystem', 'subject', 'timestamp',
        ])
      })
    })
  })

  // ── flag ON: recall + an ordering that can surface it ──────────────────────

  describe('flag on', () => {
    beforeEach(() => { process.env[FLAG] = '1' })

    it('surfaces a vector-only hit with zero term overlap above a weak lexical hit', async () => {
      const { tool } = buildTool({
        mem0: [LEX_STRONG, LEX_WEAK],
        similar: [vectorHit({ id: SEMANTIC_ONLY.id, similarity: 0.83 })],
        entries: { [SEMANTIC_ONLY.id]: SEMANTIC_ONLY },
      })
      const res = await tool.search({ query: QUERY })

      const semantic = res.results.find(r => r.id === SEMANTIC_ONLY.id)
      expect(semantic).toBeDefined()
      // The premise of the whole change: the lexical scorer gives it nothing.
      expect(semantic!._relevance).toBe(0)
      // …yet RRF ranks it on its vector standing (#1 in that arm), so it lands ahead of
      // the weak lexical hit (#2 in the lexical arm) rather than at the bottom.
      expect(res.results.map(r => r.id)).toEqual(['lex-strong', 'sem-only', 'lex-weak'])
      expect(res.sources.vector).toBe(1)
    })

    it('would have buried that same hit under the lexical ranker', async () => {
      // Control for the test above: identical inputs, flag off. It is not merely lower —
      // the vector arm never runs, so the candidate does not exist at all. This is why
      // adding recall without changing the ordering would have accomplished nothing.
      delete process.env[FLAG]
      const { tool } = buildTool({
        mem0: [LEX_STRONG, LEX_WEAK],
        similar: [vectorHit({ id: SEMANTIC_ONLY.id, similarity: 0.83 })],
        entries: { [SEMANTIC_ONLY.id]: SEMANTIC_ONLY },
      })
      const res = await tool.search({ query: QUERY })
      expect(res.results.map(r => r.id)).toEqual(['lex-strong', 'lex-weak'])
    })

    it('exposes _lexicalRank, _vectorRank, _vectorSimilarity and _rrf on every result', async () => {
      const { tool } = buildTool({
        mem0: [LEX_STRONG],
        similar: [vectorHit({ id: SEMANTIC_ONLY.id, similarity: 0.83 })],
        entries: { [SEMANTIC_ONLY.id]: SEMANTIC_ONLY },
      })
      const res = await tool.search({ query: QUERY })
      const byId = Object.fromEntries(res.results.map(r => [r.id, r]))

      expect(byId['lex-strong']._lexicalRank).toBe(1)
      expect(byId['lex-strong']._vectorRank).toBeUndefined()
      expect(byId['lex-strong']._rrf).toBeCloseTo(1 / 61, 6)

      expect(byId['sem-only']._vectorRank).toBe(1)
      expect(byId['sem-only']._vectorSimilarity).toBe(0.83)
      expect(byId['sem-only']._lexicalRank).toBeUndefined()

      // _score is the fused value, so the eval harness's shippedRanker (which re-sorts
      // by _score) replays the ordering the service actually served.
      for (const r of res.results) expect(r._score).toBe(r._rrf)
      expect((res as any)._hybridRetrieval).toBe(true)
    })

    it('carries the hybrid signals into the KMS_EVAL_CAPTURE pool', async () => {
      await withEvalCapture(async () => {
        const { tool } = buildTool({
          mem0: [LEX_STRONG],
          similar: [vectorHit({ id: SEMANTIC_ONLY.id, similarity: 0.83 })],
          entries: { [SEMANTIC_ONLY.id]: SEMANTIC_ONLY },
        })
        const res = await tool.search({ query: QUERY })
        const captured = Object.fromEntries(res._evalCapture!.candidates.map(c => [c.id, c]))

        expect(res._evalCapture!.poolSize).toBe(2)
        expect(captured['sem-only']._vectorRank).toBe(1)
        expect(captured['sem-only']._vectorSimilarity).toBe(0.83)
        expect(captured['sem-only']._rrf).toBeCloseTo(1 / 61, 6)
        expect(captured['lex-strong']._lexicalRank).toBe(1)
        expect(typeof captured['lex-strong']._lexicalScore).toBe('number')
      })
    })

    it('deduplicates a document found by both arms into ONE candidate scoring in both', async () => {
      const { tool } = buildTool({
        mem0: [LEX_STRONG],
        mongodb: [LEX_WEAK],
        similar: [vectorHit({ id: LEX_STRONG.id, similarity: 0.91, content_preview: LEX_STRONG.content.slice(0, 20) })],
        entries: { [LEX_STRONG.id]: LEX_STRONG },
      })
      const res = await tool.search({ query: QUERY })

      expect(res.results.filter(r => r.id === LEX_STRONG.id)).toHaveLength(1)
      const merged = res.results.find(r => r.id === LEX_STRONG.id)!
      expect(merged._sourceSystems.sort()).toEqual(['mem0', 'vector'])
      expect(merged._lexicalRank).toBe(1)
      expect(merged._vectorRank).toBe(1)
      // Agreement across arms: both RRF terms accrue to the single merged candidate.
      expect(merged._rrf).toBeCloseTo(2 / 61, 6)
      // The truncated preview must not overwrite the full stored content.
      expect(merged.content).toBe(LEX_STRONG.content)
      // Raw count still sees three rows; the pool sees two documents.
      expect(res.totalFound).toBe(3)
      expect(res._evalCapture).toBeUndefined()
    })

    it('rehydrates a vector-only hit to full content, not the 200-char preview', async () => {
      const { tool } = buildTool({
        similar: [vectorHit({ id: SEMANTIC_ONLY.id, content_preview: 'Top-line projections for the' })],
        entries: { [SEMANTIC_ONLY.id]: SEMANTIC_ONLY },
      })
      const res = await tool.search({ query: QUERY })
      expect(res.results[0].content).toBe(SEMANTIC_ONLY.content)
      expect(res.results[0].confidence).toBe(1)
    })

    it('falls back to the preview when the backend cannot rehydrate', async () => {
      const { tool } = buildTool({
        similar: [vectorHit({ id: 'unknown-id', content_preview: 'a preview only' })],
        entries: {},
      })
      const res = await tool.search({ query: QUERY })
      expect(res.results[0].content).toBe('a preview only')
    })

    // ── degradation ─────────────────────────────────────────────────────────

    it('falls back to lexical when the embedder throws', async () => {
      const embedder = stubEmbedder({
        embed: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434')),
      } as any)
      const { tool, findSimilar } = buildTool({ mem0: [LEX_STRONG, LEX_WEAK], embedder })

      const res = await tool.search({ query: QUERY })
      expect(res.results.map(r => r.id)).toEqual(['lex-strong', 'lex-weak'])
      expect(res.sources.vector).toBe(0)
      expect(findSimilar).not.toHaveBeenCalled()
      expect(res.results.every(r => r._vectorRank === undefined)).toBe(true)
    })

    it('falls back to lexical when Ollama reports itself unavailable (without paying the embed timeout)', async () => {
      const embedder = stubEmbedder({ isAvailable: jest.fn().mockResolvedValue(false) } as any)
      const { tool } = buildTool({ mem0: [LEX_STRONG], embedder })

      const res = await tool.search({ query: QUERY })
      expect(res.results.map(r => r.id)).toEqual(['lex-strong'])
      expect(embedder.embed).not.toHaveBeenCalled()
    })

    it('falls back to lexical when no embedder is injected and Ollama is unreachable', async () => {
      // No embedder injected → the lazy fallback constructs an Ollama client. Point it
      // at a closed port so the outcome is decided by this test rather than by whether
      // the machine running it happens to have Ollama up.
      const originalUrl = process.env.OLLAMA_BASE_URL
      process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1'
      try {
        const { tool, findSimilar } = buildTool({ mem0: [LEX_STRONG], embedder: null })
        const res = await tool.search({ query: QUERY })
        expect(res.results.map(r => r.id)).toEqual(['lex-strong'])
        expect(findSimilar).not.toHaveBeenCalled()
      } finally {
        if (originalUrl === undefined) delete process.env.OLLAMA_BASE_URL
        else process.env.OLLAMA_BASE_URL = originalUrl
      }
    })

    it('falls back to lexical when the backend has no findSimilar (older binding)', async () => {
      const { tool, embedder } = buildTool({
        mem0: [LEX_STRONG, LEX_WEAK],
        withoutFindSimilar: true,
      })
      const res = await tool.search({ query: QUERY })

      expect(res.results.map(r => r.id)).toEqual(['lex-strong', 'lex-weak'])
      expect(res.sources.vector).toBe(0)
      // Cheapest check first — no point embedding a query nothing can search with it.
      expect(embedder!.embed).not.toHaveBeenCalled()
    })

    it('falls back to lexical when findSimilar itself throws', async () => {
      const { tool } = buildTool({
        mem0: [LEX_STRONG],
        similar: new Error('vector index unavailable'),
      })
      const res = await tool.search({ query: QUERY })
      expect(res.results.map(r => r.id)).toEqual(['lex-strong'])
      expect(res.sources.vector).toBe(0)
    })

    it('returns lexical results when the vector arm legitimately finds nothing (the common case today)', async () => {
      // Only ~29% of the corpus is embedded (806/2761, counted 2026-08-01), so an empty
      // vector arm is normal.
      const { tool, findSimilar } = buildTool({ mem0: [LEX_STRONG, LEX_WEAK], similar: [] })
      const res = await tool.search({ query: QUERY })
      expect(findSimilar).toHaveBeenCalledTimes(1)
      expect(res.results.map(r => r.id)).toEqual(['lex-strong', 'lex-weak'])
      expect(res.sources.vector).toBe(0)
    })

    // ── filter plumbing ─────────────────────────────────────────────────────

    it('pushes single-valued filters down and post-filters multi-valued ones', async () => {
      const { tool, findSimilar } = buildTool({
        similar: [
          vectorHit({ id: 'a', contentType: 'insight' }),
          vectorHit({ id: 'b', contentType: 'procedure' }),
        ],
      })

      await tool.search({
        query: QUERY,
        filters: { userId: 'richard_yaker', contentType: ['insight'], subject: 'KMS.retrieval' },
      })
      expect(findSimilar.mock.calls[0][1]).toMatchObject({
        userId: 'richard_yaker',
        contentType: 'insight',
        subject: 'KMS.retrieval',
        includeFlagged: false,
      })

      const res = await tool.search({
        query: QUERY,
        filters: { userId: 'richard_yaker', contentType: ['insight', 'fact'] },
      })
      // Two values cannot be pushed into findSimilar's single-valued option…
      expect(findSimilar.mock.calls[1][1].contentType).toBeUndefined()
      // …so the discard happens here instead: 'procedure' is not in the allowed set.
      expect(res.results.map(r => r.id)).toEqual(['a'])
    })

    it('excludes a vector-only hit whose source is not in filters.source', async () => {
      // `findSimilar` has no `source` parameter to push a filter down into (unlike
      // contentType/subject), so this filter can ONLY be enforced as a post-filter here.
      // Without it, a caller asking for filters.source: ['technical'] would get results
      // the vector arm found under 'personal' — candidates it explicitly excluded.
      const { tool } = buildTool({
        similar: [
          vectorHit({ id: 'wrong-source', source: 'personal' }),
          vectorHit({ id: 'right-source', source: 'technical' }),
        ],
      })
      const res = await tool.search({
        query: QUERY,
        filters: { source: ['technical'] },
      })
      expect(res.results.map(r => r.id)).toEqual(['right-source'])
    })

    it('propagates includeFlagged to the vector arm', async () => {
      const { tool, findSimilar } = buildTool({ similar: [] })
      await tool.search({ query: QUERY, options: { includeFlagged: true } })
      expect(findSimilar.mock.calls[0][1].includeFlagged).toBe(true)
    })
  })

  // ── cache isolation between the two modes ─────────────────────────────────

  it('does not serve a lexical-mode cache entry to a hybrid-mode search', async () => {
    const store = new Map<string, any>()
    const cache = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: any) => { store.set(k, v) }),
      invalidate: jest.fn().mockResolvedValue(undefined),
    }
    const graph: any = {
      search: jest.fn().mockResolvedValue([]),
      getEntitySummary: jest.fn().mockResolvedValue(null),
      getOperationalNodes: jest.fn().mockResolvedValue([]),
      findById: jest.fn(() => SEMANTIC_ONLY),
      findSimilar: jest.fn().mockResolvedValue([vectorHit({ id: SEMANTIC_ONLY.id })]),
    }
    const mem0 = { search: jest.fn().mockResolvedValue([LEX_STRONG]) }
    const tool = new UnifiedSearchTool(
      { mongodb: { search: jest.fn().mockResolvedValue([]) }, graph, mem0 } as any,
      cache as any,
      stubEmbedder()
    )

    delete process.env[FLAG]
    const lexical = await tool.search({ query: QUERY })
    expect(lexical.fromCache).toBe(false)
    expect(lexical.results).toHaveLength(1)

    process.env[FLAG] = '1'
    const hybrid = await tool.search({ query: QUERY })
    // Same cache key (it hashes only query+filters+options) — must NOT be a hit, or an
    // A/B of the two rankers would be comparing one against a cached copy of the other.
    expect(hybrid.fromCache).toBe(false)
    expect(hybrid.results).toHaveLength(2)

    // And the hybrid entry round-trips its own marker back out.
    const again = await tool.search({ query: QUERY })
    expect(again.fromCache).toBe(true)
    expect((again as any)._hybridRetrieval).toBe(true)
  })

  it('restores a pre-existing KMS_EVAL_CAPTURE value instead of deleting it', async () => {
    const SENTINEL = 'set-by-something-else-in-the-process'
    process.env.KMS_EVAL_CAPTURE = SENTINEL
    try {
      await withEvalCapture(async () => {
        expect(process.env.KMS_EVAL_CAPTURE).toBe('1')
        const { tool } = buildTool({ mem0: [LEX_STRONG], similar: [vectorHit()] })
        await tool.search({ query: QUERY })
      })
      // An unconditional `delete` here would leave this `undefined`, leaking state
      // into whatever test or process runs next instead of restoring it.
      expect(process.env.KMS_EVAL_CAPTURE).toBe(SENTINEL)
    } finally {
      delete process.env.KMS_EVAL_CAPTURE
    }
  })
})
