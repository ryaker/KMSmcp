/**
 * Mem0Storage.search — filter-shape and client-side minConfidence tests.
 *
 * Regression cover for a bug that returned zero Mem0 results for any filtered
 * query, silently: `buildMem0Filters` sent content_type/source/min_confidence
 * as BARE top-level keys in the search filters object. Mem0's hosted API only
 * accepts a fixed top-level key set (see the allow-list in Mem0Storage.ts) and
 * throws ValidationError for anything else, which search()'s own catch
 * swallowed and turned into `[]` — no error surfaced to the caller, and
 * `unified_search` calls that passed contentType/source/minConfidence got
 * NOTHING from Mem0, indistinguishable from "no matches."
 *
 * Fix: content_type/source/subject nest under `metadata` (the one top-level
 * key Mem0 does accept for custom fields); minConfidence isn't sent at all —
 * Mem0 has no confidence predicate — and is instead applied client-side in
 * search() after results come back, against metadata.confidence.
 */

import { Mem0Storage } from '../storage/Mem0Storage.js'
import type { KnowledgeQuery } from '../types/index.js'

describe('Mem0Storage.search — filter shape', () => {
  let storage: Mem0Storage
  let mockClient: { search: jest.Mock }

  beforeEach(() => {
    mockClient = { search: jest.fn().mockResolvedValue({ results: [] }) }
    storage = new Mem0Storage({ apiKey: 'test-key', defaultUserId: 'test-user' } as any)
    ;(storage as any).client = mockClient
  })

  const run = (filters: KnowledgeQuery['filters']) =>
    storage.search({ query: 'anything', filters } as KnowledgeQuery)

  const sentFilters = () => mockClient.search.mock.calls[0][1].filters

  it('nests contentType under metadata rather than sending it top-level', async () => {
    await run({ contentType: ['fact'] })
    expect(sentFilters()).toEqual({ user_id: 'test-user', metadata: { content_type: ['fact'] } })
  })

  it('nests source under metadata rather than sending it top-level', async () => {
    await run({ source: ['technical'] })
    expect(sentFilters()).toEqual({ user_id: 'test-user', metadata: { source: ['technical'] } })
  })

  it('nests subject under metadata rather than sending it top-level', async () => {
    await run({ subject: 'Phoenix.camera_count' })
    expect(sentFilters()).toEqual({
      user_id: 'test-user',
      metadata: { subject: 'Phoenix.camera_count' }
    })
  })

  it('combines multiple filters into one metadata object', async () => {
    await run({ contentType: ['fact', 'insight'], source: ['personal'], subject: 'X.y' })
    expect(sentFilters()).toEqual({
      user_id: 'test-user',
      metadata: { content_type: ['fact', 'insight'], source: ['personal'], subject: 'X.y' }
    })
  })

  it('never sends min_confidence — Mem0 has no server-side confidence predicate', async () => {
    await run({ minConfidence: 0.8 })
    const filters = sentFilters()
    expect(filters).not.toHaveProperty('min_confidence')
    expect(filters.metadata).toBeUndefined()
    expect(filters).toEqual({ user_id: 'test-user' })
  })

  it('sends only user_id when no filters are given', async () => {
    await run(undefined)
    expect(sentFilters()).toEqual({ user_id: 'test-user' })
  })
})

describe('Mem0Storage.search — client-side minConfidence', () => {
  let storage: Mem0Storage
  let mockClient: { search: jest.Mock }

  const memory = (id: string, score: number) => ({ id, memory: `entry ${id}`, score, metadata: {} })

  beforeEach(() => {
    storage = new Mem0Storage({ apiKey: 'test-key', defaultUserId: 'test-user' } as any)
  })

  it('drops results below minConfidence after they come back from Mem0', async () => {
    mockClient = {
      search: jest.fn().mockResolvedValue({ results: [memory('a', 0.9), memory('b', 0.4)] })
    }
    ;(storage as any).client = mockClient

    const out = await storage.search({ query: 'q', filters: { minConfidence: 0.5 } } as KnowledgeQuery)
    expect(out.map(r => r.id)).toEqual(['a'])
  })

  it('keeps everything when minConfidence is not set', async () => {
    mockClient = {
      search: jest.fn().mockResolvedValue({ results: [memory('a', 0.9), memory('b', 0.1)] })
    }
    ;(storage as any).client = mockClient

    const out = await storage.search({ query: 'q' } as KnowledgeQuery)
    expect(out.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('keeps a result exactly at the minConfidence threshold', async () => {
    mockClient = { search: jest.fn().mockResolvedValue({ results: [memory('a', 0.5)] }) }
    ;(storage as any).client = mockClient

    const out = await storage.search({ query: 'q', filters: { minConfidence: 0.5 } } as KnowledgeQuery)
    expect(out.map(r => r.id)).toEqual(['a'])
  })
})
