/**
 * KMS_EVAL_CAPTURE tests for UnifiedSearchTool.search().
 *
 * The capture exists so a ranker can be replayed offline over the exact
 * deduplicated pool a live search saw (see src/eval/rankers.ts header). These tests
 * pin: the capture is off by default, present end-to-end when enabled, exposed on
 * the declared return type (not just via a cast), and NOT silently dropped on a
 * cache hit against an entry written before capture was enabled.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'

const buildTool = (mem0Results: any[]) => {
  const mongo = { search: jest.fn().mockResolvedValue([]) }
  const graph = {
    search: jest.fn().mockResolvedValue([]),
    getEntitySummary: jest.fn().mockResolvedValue(null),
    getOperationalNodes: jest.fn().mockResolvedValue([])
  }
  const mem0 = { search: jest.fn().mockResolvedValue(mem0Results) }

  // A minimal in-memory cache stand-in — real enough to round-trip a stored
  // value back out of get(), which is what the cache-hit tests need.
  const store = new Map<string, any>()
  const cache = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: any) => { store.set(key, value) }),
    invalidate: jest.fn().mockResolvedValue(undefined)
  }

  const tool = new UnifiedSearchTool({ mongodb: mongo, graph, mem0 } as any, cache as any)
  return { tool, mongo, graph, mem0, cache }
}

const oneResult = [{
  id: 'r1',
  content: 'Ollama classify timeout raised to 8000ms',
  confidence: 1,
  metadata: { subject: 'KMS.retrieval.audit', extractedBy: 'kms-session-extract' }
}]

describe('UnifiedSearchTool — KMS_EVAL_CAPTURE', () => {
  const ORIGINAL_ENV = process.env.KMS_EVAL_CAPTURE

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.KMS_EVAL_CAPTURE
    else process.env.KMS_EVAL_CAPTURE = ORIGINAL_ENV
  })

  it('omits _evalCapture by default (flag unset)', async () => {
    delete process.env.KMS_EVAL_CAPTURE
    const { tool } = buildTool(oneResult)
    const result = await tool.search({ query: 'ollama timeout' })
    expect(result._evalCapture).toBeUndefined()
  })

  it('captures the deduplicated pool, joinable by a stable string id, when enabled', async () => {
    process.env.KMS_EVAL_CAPTURE = '1'
    const { tool } = buildTool(oneResult)
    const result = await tool.search({ query: 'ollama timeout' })

    expect(result._evalCapture).toBeDefined()
    expect(result._evalCapture!.candidates).toHaveLength(1)
    const candidate = result._evalCapture!.candidates[0]
    expect(typeof candidate.id).toBe('string')
    expect(candidate.id).toBe('r1')
    // metaShareAtK reads exactly these two fields off the capture.
    expect(candidate.subject).toBe('KMS.retrieval.audit')
    expect(candidate.extractedBy).toBe('kms-session-extract')
  })

  it('returns _evalCapture on a cache hit when the cached entry has a full capture', async () => {
    process.env.KMS_EVAL_CAPTURE = '1'
    const { tool } = buildTool(oneResult)

    const first = await tool.search({ query: 'ollama timeout' })
    expect(first.fromCache).toBe(false)
    expect(first._evalCapture).toBeDefined()

    const second = await tool.search({ query: 'ollama timeout' })
    expect(second.fromCache).toBe(true)
    expect(second._evalCapture).toBeDefined()
    expect(second._evalCapture!.candidates[0].id).toBe('r1')
  })

  it('treats a cache entry written without capture as a miss when the flag is later enabled', async () => {
    const { tool, mem0 } = buildTool(oneResult)

    delete process.env.KMS_EVAL_CAPTURE
    const first = await tool.search({ query: 'ollama timeout' })
    expect(first._evalCapture).toBeUndefined()
    expect(mem0.search).toHaveBeenCalledTimes(1)

    process.env.KMS_EVAL_CAPTURE = '1'
    const second = await tool.search({ query: 'ollama timeout' })
    // Must NOT be served from the capture-less cache entry as a hit.
    expect(second.fromCache).toBe(false)
    expect(second._evalCapture).toBeDefined()
    expect(mem0.search).toHaveBeenCalledTimes(2)
  })
})
