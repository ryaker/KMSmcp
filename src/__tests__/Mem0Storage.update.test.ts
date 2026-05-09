/**
 * Unit tests for Mem0Storage.update — kms_update propagation to Mem0.
 *
 * Covers the contract added to fix Mem0 corpus drift after kms_update:
 *   - Looks the Mem0 internal id up via search-and-filter on metadata.kms_id.
 *   - Calls client.update(mem0Id, content) once located.
 *   - Probe-and-skip on zero matches (entry never routed to Mem0).
 *   - 404 from client.update is swallowed (race between search and update).
 *   - No-op when content is missing (Mem0 update endpoint requires text).
 *   - User-id scope flows into the search filter.
 *
 * The Mem0 SDK is injected directly into the private `client` field on a
 * partially-constructed Mem0Storage instance — same pattern several other
 * tests would use, avoiding a real network round-trip.
 */

import { Mem0Storage } from '../storage/Mem0Storage.js'

describe('Mem0Storage.update — kms_update propagation', () => {
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
      update: jest.fn().mockResolvedValue([{ id: 'mem0-id-xyz', memory: 'updated' }]),
      delete: jest.fn().mockResolvedValue({ message: 'ok' }),
      add: jest.fn().mockResolvedValue([{ id: 'mem0-id-xyz' }]),
      get: jest.fn(),
      getAll: jest.fn()
    }

    storage = new Mem0Storage({
      apiKey: 'test-key',
      defaultUserId: 'test-user'
    } as any)
    // Inject the mock client directly — bypass the real initialize() which
    // would hit the live Mem0 endpoint and fail on a fake API key.
    ;(storage as any).client = mockClient
  })

  // -------------------------------------------------------------------------
  // happy path: search hit → update called
  // -------------------------------------------------------------------------

  describe('search-and-update happy path', () => {
    it('looks up mem0 id by metadata.kms_id and calls client.update with new content', async () => {
      mockClient.search.mockResolvedValue({
        results: [
          { id: 'mem0-id-xyz', memory: 'old', metadata: { kms_id: 'kms-abc' } }
        ]
      })

      const result = await storage.update('kms-abc', 'corrected content')

      // Search was scoped to user_id and used the kms id as the query.
      // api_version: 'v2' is REQUIRED — see Mem0Storage.getStats() comments
      // for the v1 URLSearchParams flattening bug. Asserting it here keeps
      // any future regression that drops the flag visible at test time.
      expect(mockClient.search).toHaveBeenCalledWith(
        'kms-abc',
        expect.objectContaining({
          api_version: 'v2',
          topK: 50,
          filters: expect.objectContaining({ user_id: 'test-user' })
        })
      )
      // Update was called with the looked-up Mem0 id, not the kms id.
      expect(mockClient.update).toHaveBeenCalledWith('mem0-id-xyz', 'corrected content')
      expect(result).toBe(true)
    })

    it('honours explicit userId argument over the default', async () => {
      mockClient.search.mockResolvedValue({
        results: [{ id: 'mem0-id-xyz', metadata: { kms_id: 'kms-abc' } }]
      })

      await storage.update('kms-abc', 'corrected', undefined, 'caller-user')

      expect(mockClient.search).toHaveBeenCalledWith(
        'kms-abc',
        expect.objectContaining({
          filters: expect.objectContaining({ user_id: 'caller-user' })
        })
      )
    })

    it('handles bare-array search response shape (non-paginated)', async () => {
      // Some Mem0 endpoints return a bare array instead of { results: [...] }.
      mockClient.search.mockResolvedValue([
        { id: 'mem0-id-xyz', metadata: { kms_id: 'kms-abc' } }
      ])

      const result = await storage.update('kms-abc', 'corrected')
      expect(mockClient.update).toHaveBeenCalledWith('mem0-id-xyz', 'corrected')
      expect(result).toBe(true)
    })

    it('uses the first match when search returns multiple hits with same kms_id', async () => {
      mockClient.search.mockResolvedValue({
        results: [
          { id: 'mem0-id-first', metadata: { kms_id: 'kms-abc' } },
          { id: 'mem0-id-second', metadata: { kms_id: 'kms-abc' } }
        ]
      })

      const result = await storage.update('kms-abc', 'corrected')
      expect(mockClient.update).toHaveBeenCalledWith('mem0-id-first', 'corrected')
      expect(mockClient.update).toHaveBeenCalledTimes(1)
      expect(result).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // probe-and-skip (entry not in Mem0)
  // -------------------------------------------------------------------------

  describe('probe-and-skip', () => {
    it('returns false silently when no search results contain matching kms_id', async () => {
      mockClient.search.mockResolvedValue({ results: [] })

      const result = await storage.update('kms-missing', 'corrected')

      expect(mockClient.update).not.toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it('exact-matches metadata.kms_id (no false positive on near-match content)', async () => {
      // Search returned hits but none have a matching kms_id — must skip,
      // not update the wrong entry.
      mockClient.search.mockResolvedValue({
        results: [
          { id: 'mem0-id-other', metadata: { kms_id: 'kms-different' } },
          { id: 'mem0-id-third', metadata: { kms_id: 'something-else' } }
        ]
      })

      const result = await storage.update('kms-abc', 'corrected')
      expect(mockClient.update).not.toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it('skips when search response has no metadata at all', async () => {
      mockClient.search.mockResolvedValue({
        results: [{ id: 'mem0-id-xyz', memory: 'something' }]  // no metadata
      })

      const result = await storage.update('kms-abc', 'corrected')
      expect(mockClient.update).not.toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it('returns false silently when search itself errors', async () => {
      // Transient Mem0 search failure — non-fatal, log and skip.
      mockClient.search.mockRejectedValue(new Error('Mem0 search timeout'))

      const result = await storage.update('kms-abc', 'corrected')
      expect(mockClient.update).not.toHaveBeenCalled()
      expect(result).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // 404 swallowing on update (race between search and update)
  // -------------------------------------------------------------------------

  describe('404 / not-found handling on update', () => {
    beforeEach(() => {
      mockClient.search.mockResolvedValue({
        results: [{ id: 'mem0-id-xyz', metadata: { kms_id: 'kms-abc' } }]
      })
    })

    it('swallows 404 status code error from client.update (probe-and-skip)', async () => {
      mockClient.update.mockRejectedValue(new Error('Request failed with status 404'))

      const result = await storage.update('kms-abc', 'corrected')
      expect(result).toBe(false)
      // Should not bubble up.
    })

    it('swallows "not found" error message from client.update', async () => {
      mockClient.update.mockRejectedValue(new Error('Memory not found'))

      const result = await storage.update('kms-abc', 'corrected')
      expect(result).toBe(false)
    })

    it('swallows "does not exist" error message from client.update', async () => {
      mockClient.update.mockRejectedValue(new Error('Resource does not exist'))

      const result = await storage.update('kms-abc', 'corrected')
      expect(result).toBe(false)
    })

    it('returns false on non-404 errors (still logged + still non-fatal)', async () => {
      // 500 / network errors are distinct from probe-and-skip but Mem0
      // propagation is best-effort by design — the outer catch returns
      // false so a Mem0 outage never tears down a kms_update that already
      // succeeded against Mongo + SparrowDB. The error path logs at
      // console.error so ops can see Mem0 is misbehaving.
      mockClient.update.mockRejectedValue(new Error('500 Internal Server Error'))

      const result = await storage.update('kms-abc', 'corrected')
      expect(result).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // no-content guard
  // -------------------------------------------------------------------------

  describe('no-content guard', () => {
    it('returns false without calling search or update when content is undefined', async () => {
      const result = await storage.update('kms-abc')
      expect(mockClient.search).not.toHaveBeenCalled()
      expect(mockClient.update).not.toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it('returns false when content is empty string', async () => {
      const result = await storage.update('kms-abc', '')
      expect(mockClient.search).not.toHaveBeenCalled()
      expect(mockClient.update).not.toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it('returns false when content is null', async () => {
      const result = await storage.update('kms-abc', null as any)
      expect(mockClient.search).not.toHaveBeenCalled()
      expect(mockClient.update).not.toHaveBeenCalled()
      expect(result).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // user-id resolution
  // -------------------------------------------------------------------------

  describe('user-id resolution', () => {
    it('falls back to "personal" when no defaultUserId and no caller userId', async () => {
      const noDefault = new Mem0Storage({ apiKey: 'k' } as any)
      ;(noDefault as any).client = mockClient
      mockClient.search.mockResolvedValue({
        results: [{ id: 'mem0-id-xyz', metadata: { kms_id: 'kms-abc' } }]
      })

      await noDefault.update('kms-abc', 'corrected')
      expect(mockClient.search).toHaveBeenCalledWith(
        'kms-abc',
        expect.objectContaining({
          filters: expect.objectContaining({ user_id: 'personal' })
        })
      )
    })
  })
})
