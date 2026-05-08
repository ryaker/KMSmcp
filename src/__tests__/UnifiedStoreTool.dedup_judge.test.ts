/**
 * DG-T2-A — Tier 2 LLM-judge integration tests (issue #49).
 *
 * Verifies the UnifiedStoreTool wiring of LLMJudgeService into the dedup
 * gate's confirm-band classification path:
 *
 *   1. Confirm-band candidates trigger classify() with the right args
 *   2. Refuse-band candidates skip the LLM and get 'duplicate' inline
 *   3. Mixed bands: only confirm-band candidates call the judge
 *   4. judge.classify() throw → that candidate gets null, others succeed
 *   5. judge.isAvailable() → false → no calls, all null (Tier 1 result still ships)
 *   6. Cached repeats don't re-invoke classify() (cache hit)
 *   7. judge === null (not configured) → no calls, refuse band still gets 'duplicate'
 *   8. parseLLMRelation handles all 6 valid relations + falls back to 'unrelated'
 *   9. LRUCache: bumps on read, evicts oldest at capacity
 *  10. judgeCacheKey: deterministic, content-pair sensitive
 */

import { UnifiedStoreTool, type UnifiedStoreResult, type DedupRequiredResponse } from '../tools/UnifiedStoreTool.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import type { GraphStorage } from '../types/index.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'
import type { LLMJudgeService, LLMRelation } from '../embedding/LLMJudgeService.js'
import {
  parseLLMRelation,
  judgeCacheKey,
  LRUCache,
} from '../embedding/LLMJudgeService.js'

function isDedupRequired(r: UnifiedStoreResult): r is DedupRequiredResponse {
  return (r as any).status === 'dedup_required'
}

function unitVec(axis = 0, dim = 768): Float32Array {
  const v = new Float32Array(dim)
  v[axis] = 1
  return v
}

describe('DG-T2-A — UnifiedStoreTool LLM judge wiring (issue #49)', () => {
  let mongo: any
  let graph: any
  let mem0: any
  let cache: any
  let router: IntelligentStorageRouter
  let embedder: jest.Mocked<EmbeddingService>
  let judge: jest.Mocked<LLMJudgeService>

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
      embed: jest.fn().mockResolvedValue(unitVec(0)),
      isAvailable: jest.fn().mockResolvedValue(true)
    } as unknown as jest.Mocked<EmbeddingService>

    judge = {
      modelId: 'claude-haiku-4-5-20251001',
      classify: jest.fn().mockResolvedValue('complement' as LLMRelation),
      isAvailable: jest.fn().mockResolvedValue(true)
    } as unknown as jest.Mocked<LLMJudgeService>
  })

  function makeTool(judgeOverride: LLMJudgeService | null | undefined = judge): UnifiedStoreTool {
    return new UnifiedStoreTool(
      router,
      { mongodb: mongo, graph, mem0 },
      cache,
      null, null,
      embedder,
      judgeOverride ?? null
    )
  }

  // -------------------------------------------------------------------------
  // 1. Confirm-band → classify() called with the right args
  // -------------------------------------------------------------------------

  it('calls classify() for confirm-band candidate with new + candidate content', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'existing-fact',
        similarity: 0.83,  // confirm band: 0.78 ≤ 0.83 < 0.88
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'EXISTING CONTENT preview'
      }
    ])

    judge.classify.mockResolvedValue('supersedes')

    const tool = makeTool()
    const result = await tool.store({
      content: 'NEW CONTENT for the gate',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    expect(judge.classify).toHaveBeenCalledTimes(1)
    expect(judge.classify).toHaveBeenCalledWith({
      newContent: 'NEW CONTENT for the gate',
      candidateContent: 'EXISTING CONTENT preview'
    })
    expect(result.candidates[0].llm_relation).toBe('supersedes')
    expect(result.band).toBe('confirm')
  })

  // -------------------------------------------------------------------------
  // 2. Refuse-band: 'duplicate' inline, no classify() call
  // -------------------------------------------------------------------------

  it('refuse-band candidates get llm_relation=duplicate without calling classify()', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      {
        id: 'existing-fact',
        similarity: 0.95,  // refuse band: ≥ 0.88
        contentType: 'fact',
        source: 'technical',
        created: '2026-04-01T00:00:00Z',
        flag: null,
        content_preview: 'near-identical content'
      }
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'newer near-identical content',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    expect(judge.classify).not.toHaveBeenCalled()  // free win — saves $$$
    expect(result.candidates[0].llm_relation).toBe('duplicate')
    expect(result.band).toBe('refuse')
  })

  // -------------------------------------------------------------------------
  // 3. Mixed bands in a single response: only confirm-band hits judge
  // -------------------------------------------------------------------------

  it('with mixed-similarity candidates, only confirm-band ones call classify()', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      // Top is refuse-band → triggers gate
      { id: 'high', similarity: 0.91, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'high-sim content' },
      // Confirm-band → judge called
      { id: 'mid',  similarity: 0.82, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'mid-sim content' },
      // Below confirm threshold (0.78) → still in candidates list since findSimilar
      // returns top-K, but llm_relation stays null (no classification needed)
      { id: 'low',  similarity: 0.71, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'low-sim content' },
    ])

    judge.classify.mockResolvedValue('complement')

    const tool = makeTool()
    const result = await tool.store({
      content: 'new content',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    // Only the mid-sim candidate (0.82) gets classified — high gets 'duplicate'
    // inline, low stays null.
    expect(judge.classify).toHaveBeenCalledTimes(1)
    expect(judge.classify).toHaveBeenCalledWith({
      newContent: 'new content',
      candidateContent: 'mid-sim content'
    })

    const byId = Object.fromEntries(result.candidates.map(c => [c.id, c.llm_relation]))
    expect(byId['high']).toBe('duplicate')
    expect(byId['mid']).toBe('complement')
    expect(byId['low']).toBeNull()
  })

  // -------------------------------------------------------------------------
  // 4. classify() failure for ONE candidate doesn't sink the whole response
  // -------------------------------------------------------------------------

  it('per-candidate classify() throw → that candidate=null, others classified', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      // Both in confirm band — both should be classified in parallel.
      // Top is the one we'll have classify() reject for.
      { id: 'a', similarity: 0.85, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'A content' },
      { id: 'b', similarity: 0.81, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'B content' },
    ])

    // First call (for 'a') rejects, second (for 'b') succeeds.
    judge.classify
      .mockRejectedValueOnce(new Error('judge timeout'))
      .mockResolvedValueOnce('complement')

    const tool = makeTool()
    const result = await tool.store({
      content: 'new content',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    expect(judge.classify).toHaveBeenCalledTimes(2)
    const byId = Object.fromEntries(result.candidates.map(c => [c.id, c.llm_relation]))
    expect(byId['a']).toBeNull()         // failed classify → null
    expect(byId['b']).toBe('complement') // succeeded
    // Critical: gate response still ships — failure didn't abort
    expect(result.status).toBe('dedup_required')
  })

  // -------------------------------------------------------------------------
  // 5. judge.isAvailable() → false → no classify() calls
  // -------------------------------------------------------------------------

  it('judge unavailable → no classify() calls; confirm-band gets null', async () => {
    judge.isAvailable.mockResolvedValue(false)
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      { id: 'a', similarity: 0.83, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'A' },
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'new content',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    expect(judge.classify).not.toHaveBeenCalled()
    expect(result.candidates[0].llm_relation).toBeNull()
    // Tier 1 result still ships — gate refusal works without Tier 2
    expect(result.band).toBe('confirm')
  })

  // -------------------------------------------------------------------------
  // 6. judge.isAvailable() throw → degrades gracefully (no calls, all null)
  // -------------------------------------------------------------------------

  it('judge.isAvailable() throw → skips Tier 2, still ships gate response', async () => {
    judge.isAvailable.mockRejectedValue(new Error('availability check exploded'))
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      { id: 'a', similarity: 0.83, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'A' },
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'new content',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return
    expect(judge.classify).not.toHaveBeenCalled()
    expect(result.candidates[0].llm_relation).toBeNull()
  })

  // -------------------------------------------------------------------------
  // 7. judge === null (not configured) → degrades gracefully
  // -------------------------------------------------------------------------

  it('llmJudge=null → no Tier 2 attempted; refuse-band still gets "duplicate"', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      { id: 'high', similarity: 0.91, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'high' },
      { id: 'mid',  similarity: 0.82, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'mid'  },
    ])

    const tool = makeTool(null)
    const result = await tool.store({
      content: 'new content',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    const byId = Object.fromEntries(result.candidates.map(c => [c.id, c.llm_relation]))
    expect(byId['high']).toBe('duplicate')  // free-win path doesn't need judge
    expect(byId['mid']).toBeNull()           // confirm-band needs judge → null
    // Judge mock was injected per-test but tool was made with null override —
    // verify the mock was never invoked.
    expect(judge.classify).not.toHaveBeenCalled()
    expect(judge.isAvailable).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 8. classify() runs in parallel for multiple confirm-band candidates
  // -------------------------------------------------------------------------

  it('classifies multiple confirm-band candidates in parallel (Promise.allSettled)', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      { id: 'a', similarity: 0.85, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'A' },
      { id: 'b', similarity: 0.83, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'B' },
      { id: 'c', similarity: 0.80, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'C' },
    ])

    // Block each classify() call until all three have entered the mock. This
    // only resolves if the production code dispatched them in parallel —
    // sequential dispatch would deadlock here (the barrier never reaches 3).
    let startedCount = 0
    let barrierResolve: (() => void) | undefined
    const barrier = new Promise<void>(resolve => { barrierResolve = resolve })

    judge.classify.mockImplementation(async ({ candidateContent }: { candidateContent: string }) => {
      startedCount++
      if (startedCount === 3) barrierResolve!()
      await barrier
      const map: Record<string, LLMRelation> = { A: 'duplicate', B: 'complement', C: 'unrelated' }
      return map[candidateContent] ?? 'unrelated'
    })

    const tool = makeTool()
    const result = await tool.store({
      content: 'new content',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(true)
    if (!isDedupRequired(result)) return

    expect(judge.classify).toHaveBeenCalledTimes(3)
    const byId = Object.fromEntries(result.candidates.map(c => [c.id, c.llm_relation]))
    expect(byId['a']).toBe('duplicate')
    expect(byId['b']).toBe('complement')
    expect(byId['c']).toBe('unrelated')
  })

  // -------------------------------------------------------------------------
  // 9. Distinct (sim < confirm) — gate doesn't trigger, judge not called
  // -------------------------------------------------------------------------

  it('distinct candidate (sim < 0.78) → no gate, no judge', async () => {
    ;(graph as any).findSimilar = jest.fn().mockResolvedValue([
      { id: 'a', similarity: 0.5, contentType: 'fact', source: 'technical', created: '2026-04-01T00:00:00Z', flag: null, content_preview: 'A' },
    ])

    const tool = makeTool()
    const result = await tool.store({
      content: 'new content',
      contentType: 'fact',
      userId: 'richard_yaker'
    })

    expect(isDedupRequired(result)).toBe(false)
    expect(judge.classify).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// LLMJudgeService unit tests — pure parser + cache, no UnifiedStoreTool wiring.
// ===========================================================================

describe('parseLLMRelation()', () => {
  it('matches each of the 6 valid relations', () => {
    expect(parseLLMRelation('duplicate')).toBe('duplicate')
    expect(parseLLMRelation('supersedes')).toBe('supersedes')
    expect(parseLLMRelation('supersedes-reverse')).toBe('supersedes-reverse')
    expect(parseLLMRelation('complement')).toBe('complement')
    expect(parseLLMRelation('contradicts')).toBe('contradicts')
    expect(parseLLMRelation('unrelated')).toBe('unrelated')
  })

  it('handles uppercase and whitespace', () => {
    expect(parseLLMRelation('DUPLICATE')).toBe('duplicate')
    expect(parseLLMRelation('  Complement  \n')).toBe('complement')
  })

  it('strips surrounding text and finds the relation token', () => {
    expect(parseLLMRelation('The relation is: duplicate.')).toBe('duplicate')
    expect(parseLLMRelation('My answer: contradicts!')).toBe('contradicts')
  })

  it('prefers supersedes-reverse over supersedes when both substring-match', () => {
    // The longer token must win — that's exactly the "asymmetric" relation
    // that fails when shorter matches first.
    expect(parseLLMRelation('supersedes-reverse')).toBe('supersedes-reverse')
    expect(parseLLMRelation('My answer is supersedes-reverse!')).toBe('supersedes-reverse')
  })

  it('falls back to "unrelated" on garbage input', () => {
    expect(parseLLMRelation('')).toBe('unrelated')
    expect(parseLLMRelation('hello world')).toBe('unrelated')
    expect(parseLLMRelation('I am not sure')).toBe('unrelated')
  })

  it('falls back on non-string input (defensive)', () => {
    // @ts-expect-error — testing runtime resilience
    expect(parseLLMRelation(null)).toBe('unrelated')
    // @ts-expect-error — testing runtime resilience
    expect(parseLLMRelation(undefined)).toBe('unrelated')
  })
})

describe('judgeCacheKey()', () => {
  it('produces identical keys for identical pairs', () => {
    const a = judgeCacheKey('hello', 'world')
    const b = judgeCacheKey('hello', 'world')
    expect(a).toBe(b)
  })

  it('produces different keys when content order is swapped (asymmetric)', () => {
    const a = judgeCacheKey('hello', 'world')
    const b = judgeCacheKey('world', 'hello')
    expect(a).not.toBe(b)
  })

  it('handles content with the separator character (no crash)', () => {
    // The single-character separator means boundary-collision is theoretically
    // possible (a|b + c hashes the same as a + b|c since both serialize to
    // "a|b|c"). In practice the LRU cache scope is per-process and the cost
    // of a rare hash collision is one re-classification, not data corruption.
    // This test just confirms the function doesn't throw on separator content.
    const a = judgeCacheKey('a|b', 'c')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces 64-char SHA-256 hex output', () => {
    const k = judgeCacheKey('foo', 'bar')
    expect(k).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
    expect(c.size).toBe(1)
  })

  it('evicts the least-recently-used entry at capacity', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)  // evicts 'a' (LRU)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
  })

  it('read bumps a key to most-recent (saves it from eviction)', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.get('a')      // 'a' is now most-recent
    c.set('c', 3)   // evicts 'b' (now LRU)
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
  })

  it('overwrite of existing key updates value AND bumps recency', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 99)  // overwrite + bump
    c.set('c', 3)   // evicts 'b' (LRU)
    expect(c.get('a')).toBe(99)
    expect(c.get('b')).toBeUndefined()
  })

  it('rejects non-positive maxSize', () => {
    expect(() => new LRUCache<string, number>(0)).toThrow(/maxSize/)
    expect(() => new LRUCache<string, number>(-1)).toThrow(/maxSize/)
  })

  it('clear() empties the cache', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1); c.set('b', 2)
    c.clear()
    expect(c.size).toBe(0)
    expect(c.get('a')).toBeUndefined()
  })
})

// ===========================================================================
// AnthropicHaikuJudge — integration tests with a fake SDK client.
// ===========================================================================

describe('AnthropicHaikuJudge', () => {
  // Lazy-import so jest doesn't fail collecting this file when the SDK isn't
  // present (it always is in this repo, but the pattern is safer).
  // eslint-disable-next-line @typescript-eslint/no-require-imports

  it('caches identical (newContent, candidateContent) pairs (no duplicate API calls)', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const fakeCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'complement' }]
    })
    const fakeClient = { messages: { create: fakeCreate } } as any

    const j = new AnthropicHaikuJudge({ apiKey: 'test-key', client: fakeClient })

    const a = await j.classify({ newContent: 'X', candidateContent: 'Y' })
    const b = await j.classify({ newContent: 'X', candidateContent: 'Y' })
    const c = await j.classify({ newContent: 'X', candidateContent: 'Y' })

    expect(a).toBe('complement')
    expect(b).toBe('complement')
    expect(c).toBe('complement')
    // Cached after first call — only one underlying API hit.
    expect(fakeCreate).toHaveBeenCalledTimes(1)
  })

  it('different content pairs each hit the API once', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const fakeCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'unrelated' }]
    })
    const fakeClient = { messages: { create: fakeCreate } } as any

    const j = new AnthropicHaikuJudge({ apiKey: 'test-key', client: fakeClient })
    await j.classify({ newContent: 'A', candidateContent: 'B' })
    await j.classify({ newContent: 'A', candidateContent: 'C' })
    await j.classify({ newContent: 'D', candidateContent: 'B' })

    expect(fakeCreate).toHaveBeenCalledTimes(3)
  })

  it('isAvailable() = false when no API key is configured', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const prevKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      // Inject a fake client so the SDK doesn't reject on missing key during
      // construction — we want to test the isAvailable() short-circuit.
      const fakeClient = { messages: { create: jest.fn() } } as any
      const j = new AnthropicHaikuJudge({ client: fakeClient })
      expect(await j.isAvailable()).toBe(false)
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey
    }
  })

  it('isAvailable() = true when API key is configured', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const fakeClient = { messages: { create: jest.fn() } } as any
    const j = new AnthropicHaikuJudge({ apiKey: 'test-key', client: fakeClient })
    expect(await j.isAvailable()).toBe(true)
  })

  it('parses raw model response leniently (strips surrounding text)', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const fakeCreate = jest.fn().mockResolvedValue({
      // Model returned a phrase instead of a single word — parser should
      // still extract the relation token.
      content: [{ type: 'text', text: 'The answer is contradicts.' }]
    })
    const fakeClient = { messages: { create: fakeCreate } } as any

    const j = new AnthropicHaikuJudge({ apiKey: 'test-key', client: fakeClient })
    const r = await j.classify({ newContent: 'X', candidateContent: 'Y' })
    expect(r).toBe('contradicts')
  })

  it('returns "unrelated" when response is unparseable (safe fallback)', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const fakeCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'I have no idea what these are' }]
    })
    const fakeClient = { messages: { create: fakeCreate } } as any

    const j = new AnthropicHaikuJudge({ apiKey: 'test-key', client: fakeClient })
    const r = await j.classify({ newContent: 'X', candidateContent: 'Y' })
    expect(r).toBe('unrelated')
  })

  it('returns "unrelated" without API call on empty content (defensive)', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const fakeCreate = jest.fn()
    const fakeClient = { messages: { create: fakeCreate } } as any

    const j = new AnthropicHaikuJudge({ apiKey: 'test-key', client: fakeClient })
    expect(await j.classify({ newContent: '', candidateContent: 'Y' })).toBe('unrelated')
    expect(await j.classify({ newContent: 'X', candidateContent: '' })).toBe('unrelated')
    expect(fakeCreate).not.toHaveBeenCalled()
  })

  it('passes the configured model id and includes both contents in the prompt', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const fakeCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'duplicate' }]
    })
    const fakeClient = { messages: { create: fakeCreate } } as any

    const j = new AnthropicHaikuJudge({
      apiKey: 'test-key',
      client: fakeClient,
      model: 'claude-haiku-test-model'
    })
    await j.classify({ newContent: 'NEW_TEXT_PAYLOAD', candidateContent: 'OLD_TEXT_PAYLOAD' })

    expect(fakeCreate).toHaveBeenCalledTimes(1)
    const callArgs = fakeCreate.mock.calls[0][0]
    expect(callArgs.model).toBe('claude-haiku-test-model')
    expect(callArgs.system).toContain('classifier')
    expect(callArgs.messages[0].content).toContain('NEW_TEXT_PAYLOAD')
    expect(callArgs.messages[0].content).toContain('OLD_TEXT_PAYLOAD')
    // Default modelId reads from constructor argument
    expect(j.modelId).toBe('claude-haiku-test-model')
  })

  it('default model id matches the spec (claude-haiku-4-5-20251001)', async () => {
    const { AnthropicHaikuJudge } = await import('../embedding/AnthropicHaikuJudge.js')

    const fakeClient = { messages: { create: jest.fn() } } as any
    const j = new AnthropicHaikuJudge({ apiKey: 'test-key', client: fakeClient })
    expect(j.modelId).toBe('claude-haiku-4-5-20251001')
  })
})
