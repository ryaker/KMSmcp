/**
 * Unit tests for Mem0Storage.store — narrative timestamp propagation.
 *
 * Temporal-stamp fix (DolphinBench ingestion probe, 2026-09-22): mem0's
 * server-side extractor stamps the *ingestion* date into extracted memory
 * text when no event time is given — observed rewriting a 2023-03-06
 * narrative event to "September 22, 2026" (ingestion day). The fix passes
 * the knowledge's `timestamp` (a Date) as the add's top-level `timestamp`
 * option in epoch seconds, which mem0ai@3.0.2 threads to the wire verbatim
 * via _preparePayload (camelToSnakeKeys leaves 'timestamp' unchanged).
 *
 * These tests assert the epoch-seconds conversion and that every add carries
 * it, without a live network round-trip (mock client injected into the
 * private `client` field, same pattern as Mem0Storage.update.test.ts).
 */

import { Mem0Storage } from '../storage/Mem0Storage.js'

describe('Mem0Storage.store — narrative timestamp propagation', () => {
  let storage: Mem0Storage
  let mockClient: {
    add: jest.Mock
    search: jest.Mock
    update: jest.Mock
    delete: jest.Mock
    get: jest.Mock
    getAll: jest.Mock
  }

  beforeEach(() => {
    mockClient = {
      add: jest.fn().mockResolvedValue([{ id: 'mem0-id-xyz' }]),
      search: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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

  it('passes the knowledge timestamp as epoch seconds on every add', async () => {
    // 2023-03-06T12:00:00Z === 1678104000 epoch seconds.
    const knowledge = {
      id: 'kms-abc',
      content: 'Started the new job in March',
      contentType: 'memory',
      source: 'personal',
      userId: 'dolphin/alex/run1',
      metadata: {},
      timestamp: new Date('2023-03-06T12:00:00Z'),
      confidence: 0.8
    }

    await storage.store(knowledge as any)

    expect(mockClient.add).toHaveBeenCalledTimes(1)
    const [, options] = mockClient.add.mock.calls[0]
    expect(options.timestamp).toBe(1678104000)
  })

  it('keeps the ISO timestamp inside metadata alongside the epoch top-level field', async () => {
    const knowledge = {
      id: 'kms-abc',
      content: 'Started the new job in March',
      contentType: 'memory',
      source: 'personal',
      userId: 'dolphin/alex/run1',
      metadata: {},
      timestamp: new Date('2023-03-06T12:00:00Z'),
      confidence: 0.8
    }

    await storage.store(knowledge as any)

    const [, options] = mockClient.add.mock.calls[0]
    expect(options.metadata.timestamp).toBe('2023-03-06T12:00:00.000Z')
    // Caller metadata is spread after the built-ins, preserving it.
    expect(options.metadata.kms_id).toBe('kms-abc')
  })

  it('converts a non-UTC narrative timestamp correctly', async () => {
    // 2024-01-15T08:30:00-08:00 === 2024-01-15T16:30:00Z === 1705336200.
    const knowledge = {
      id: 'kms-def',
      content: 'Moved into the new apartment',
      contentType: 'memory',
      source: 'personal',
      userId: 'dolphin/alex/run1',
      metadata: {},
      timestamp: new Date('2024-01-15T08:30:00-08:00'),
      confidence: 0.8
    }

    await storage.store(knowledge as any)

    const [, options] = mockClient.add.mock.calls[0]
    expect(options.timestamp).toBe(1705336200)
  })

  it('still scopes the add to the generated user_id', async () => {
    const knowledge = {
      id: 'kms-abc',
      content: 'Started the new job in March',
      contentType: 'memory',
      source: 'personal',
      userId: 'dolphin/alex/run1',
      metadata: {},
      timestamp: new Date('2023-03-06T12:00:00Z'),
      confidence: 0.8
    }

    await storage.store(knowledge as any)

    const [, options] = mockClient.add.mock.calls[0]
    expect(options.user_id).toBe('dolphin/alex/run1')
  })

  it('falls back to no timestamp on an Invalid Date instead of writing null', async () => {
    const knowledge = {
      id: 'kms-bad',
      content: 'Untyped caller sent an Invalid Date',
      contentType: 'memory',
      source: 'personal',
      userId: 'dolphin/alex/run1',
      metadata: {},
      timestamp: new Date('not-a-date'),
      confidence: 0.8
    }

    await storage.store(knowledge as any)

    const [, options] = mockClient.add.mock.calls[0]
    // JSON.stringify(NaN) → null on the wire; omitting the key is the safe
    // fallback (mem0 then uses its own now() default).
    expect(options.timestamp).toBeUndefined()
  })
})