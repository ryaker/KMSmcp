/**
 * Regression tests for Mem0Storage.getStats / getMemoriesForUser /
 * search call sites — every getAll() / search() call MUST pass
 * `api_version: 'v2'`.
 *
 * Why this exists: the mem0ai SDK (verified against
 * node_modules/mem0ai/dist/index.js:249-281) defaults `getAll()` to the
 * /v1/memories/ endpoint when api_version is unset. The v1 path serializes
 * options through `URLSearchParams(this._prepareParams(otherOptions))`,
 * which stringifies nested `filters: { user_id }` to literal
 * "[object Object]". The v1 server then sees no valid entity param and
 * returns:
 *
 *   "non_field_errors: One of the filters: app_id, user_id, agent_id,
 *    run_id is required!"
 *
 * That's the exact error string that surfaced live as kms_ping reporting
 * Mem0 status="degraded". Only the v2 endpoint POSTs the options as JSON
 * body — preserving the nested filters object on the wire.
 *
 * search() is similarly versioned (v1 vs /v2/memories/search/). Both v1
 * and v2 search paths POST a JSON body, so the v1 search path likely
 * works in practice — but we pin to v2 across the board for consistency
 * and to prevent the same regression class.
 */

import { Mem0Storage } from '../storage/Mem0Storage.js'

describe('Mem0Storage — api_version: v2 contract', () => {
  let storage: Mem0Storage
  let mockClient: {
    search: jest.Mock
    update: jest.Mock
    delete: jest.Mock
    add: jest.Mock
    get: jest.Mock
    getAll: jest.Mock
  }

  beforeEach(() => {
    mockClient = {
      search: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      add: jest.fn(),
      get: jest.fn(),
      getAll: jest.fn()
    }

    storage = new Mem0Storage({
      apiKey: 'test-key',
      defaultUserId: 'test-user'
    } as any)
    ;(storage as any).client = mockClient
  })

  // ---------------------------------------------------------------------
  // getStats — kms_ping path
  // ---------------------------------------------------------------------

  describe('getStats', () => {
    it('passes api_version: v2 to client.getAll (prevents v1 URLSearchParams flattening)', async () => {
      mockClient.getAll.mockResolvedValue({ count: 42, results: [], next: null, previous: null })

      const stats = await storage.getStats()

      expect(mockClient.getAll).toHaveBeenCalledTimes(1)
      const opts = mockClient.getAll.mock.calls[0][0]
      // The contract: api_version v2 + nested filters.user_id + pagination.
      expect(opts).toEqual(
        expect.objectContaining({
          api_version: 'v2',
          page: 1,
          page_size: 1,
          filters: expect.objectContaining({ user_id: 'test-user' })
        })
      )
      expect(stats.totalMemories).toBe(42)
      expect(stats.status).toBe('connected')
    })

    it('returns numeric totalMemories from { count } shape on success (kms_ping ok path)', async () => {
      mockClient.getAll.mockResolvedValue({ count: 3, results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })

      const stats = await storage.getStats()
      expect(stats.totalMemories).toBe(3)
      expect(stats.userId).toBe('test-user')
    })

    it('returns error shape — NOT degraded — when SDK rejects (matches live ping degraded path)', async () => {
      // This is the exact error the live KMS surfaced when api_version was
      // missing. Mock it here to lock in that getStats() returns a
      // structured error (not throws) so kms_ping can render the cause.
      mockClient.getAll.mockRejectedValue(
        new Error('non_field_errors: One of the filters: app_id, user_id, agent_id, run_id is required!')
      )

      const stats = await storage.getStats()
      expect(stats.status).toBe('error')
      expect(stats.totalMemories).toBe('unknown')
      expect(stats.error).toMatch(/filters/)
    })
  })

  // ---------------------------------------------------------------------
  // getMemoriesForUser
  // ---------------------------------------------------------------------

  describe('getMemoriesForUser', () => {
    it('passes api_version: v2 to client.getAll', async () => {
      mockClient.getAll.mockResolvedValue({ results: [{ id: 'm-1', memory: 'x' }] })

      await storage.getMemoriesForUser('caller-user', 25)

      expect(mockClient.getAll).toHaveBeenCalledWith(
        expect.objectContaining({
          api_version: 'v2',
          page: 1,
          page_size: 25,
          filters: expect.objectContaining({ user_id: 'caller-user' })
        })
      )
    })

    it('returns [] on SDK error without throwing', async () => {
      mockClient.getAll.mockRejectedValue(new Error('boom'))
      const result = await storage.getMemoriesForUser('caller-user')
      expect(result).toEqual([])
    })
  })

  // ---------------------------------------------------------------------
  // search() — main and testDirectSearch
  // ---------------------------------------------------------------------

  describe('search', () => {
    it('passes api_version: v2 to client.search via the unified search() entry point', async () => {
      mockClient.search.mockResolvedValue({ results: [] })

      await storage.search({
        query: 'phoenix camera count',
        options: { maxResults: 7 },
        filters: { userId: 'scoped-user' }
      } as any)

      expect(mockClient.search).toHaveBeenCalledWith(
        'phoenix camera count',
        expect.objectContaining({
          api_version: 'v2',
          topK: 7,
          filters: expect.objectContaining({ user_id: 'scoped-user' })
        })
      )
    })

    it('passes api_version: v2 to client.search via testDirectSearch', async () => {
      mockClient.search.mockResolvedValue({ results: [] })

      await storage.testDirectSearch('hello world', 'direct-user')

      expect(mockClient.search).toHaveBeenCalledWith(
        'hello world',
        expect.objectContaining({
          api_version: 'v2',
          topK: 10,
          filters: expect.objectContaining({ user_id: 'direct-user' })
        })
      )
    })
  })
})
