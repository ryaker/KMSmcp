/**
 * Unit tests for MongoDBStorage.store — id-keyed upsert (mongo-id-divergence fix).
 *
 * Bug: store() used to upsert on `contentHash` (updateOne({ contentHash },
 * { $setOnInsert }, { upsert: true })). When identical content was stored a
 * second time under a NEW `id` (e.g. two separate unified_store calls that
 * the Tier 0/1 dedup gate in UnifiedStoreTool did not catch, or a corrected
 * entry whose content happens to normalize the same), Mongo matched the
 * existing document by contentHash and left it untouched — the new id was
 * never persisted to Mongo at all. Meanwhile SparrowDB and Mem0 store the
 * same knowledge object under the NEW id (UnifiedStoreTool.storeInSystem).
 * Every later Mongo operation keyed by that new id — findById, update,
 * delete, flag (and therefore kms_review/supersede, which call flag/update)
 * — then silently missed Mongo (matchedCount/deletedCount 0), even though
 * SparrowDB/Mem0 both have the entry.
 *
 * Fix: store() now upserts on `{ id: knowledge.id }`. contentHash remains a
 * plain, non-unique field (diagnostic only) — the system's dedup layer is
 * the Tier 0/1 gate in UnifiedStoreTool, not this legacy Mongo upsert.
 *
 * These tests use a minimal in-memory fake Mongo collection (no network
 * calls) that reproduces just enough updateOne/findOne/deleteOne/updateOne
 * semantics to exercise the real bug and the real fix. The first test is
 * written to fail against the pre-fix implementation (upsert keyed on
 * contentHash) — verified by temporarily reverting store() to the old
 * filter and re-running this file.
 */

import { MongoDBStorage } from '../storage/MongoDBStorage.js'
import type { UnifiedKnowledge } from '../types/index.js'

/**
 * Tiny fake Mongo collection. Only implements the exact shapes MongoDBStorage
 * calls on `this.collection`: updateOne (both $setOnInsert+upsert and
 * $set/$unset), findOne, deleteOne. Filters here are always simple single-key
 * equality ({ id } or { contentHash }), which is all MongoDBStorage ever
 * passes for these methods.
 */
class FakeCollection {
  public docs: any[] = []

  private matches(doc: any, filter: Record<string, any>): boolean {
    return Object.entries(filter).every(([k, v]) => doc[k] === v)
  }

  async updateOne(filter: Record<string, any>, update: any, options?: { upsert?: boolean }) {
    const idx = this.docs.findIndex(d => this.matches(d, filter))
    if (idx === -1) {
      if (options?.upsert) {
        const base = { ...filter }
        if (update.$setOnInsert) Object.assign(base, update.$setOnInsert)
        if (update.$set) Object.assign(base, update.$set)
        this.docs.push(base)
        return { upsertedCount: 1, matchedCount: 0, modifiedCount: 0 }
      }
      return { upsertedCount: 0, matchedCount: 0, modifiedCount: 0 }
    }
    // Matched an existing doc — $setOnInsert is a no-op here, only $set/$unset apply.
    let modified = false
    if (update.$set) {
      Object.assign(this.docs[idx], update.$set)
      modified = true
    }
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) delete this.docs[idx][k]
      modified = true
    }
    return { upsertedCount: 0, matchedCount: 1, modifiedCount: modified ? 1 : 0 }
  }

  async findOne(filter: Record<string, any>) {
    return this.docs.find(d => this.matches(d, filter)) ?? null
  }

  async deleteOne(filter: Record<string, any>) {
    const idx = this.docs.findIndex(d => this.matches(d, filter))
    if (idx === -1) return { deletedCount: 0 }
    this.docs.splice(idx, 1)
    return { deletedCount: 1 }
  }
}

function makeKnowledge(id: string, content: string): UnifiedKnowledge {
  return {
    id,
    content,
    contentType: 'fact',
    source: 'technical',
    userId: 'richard_yaker',
    metadata: {},
    timestamp: new Date('2026-09-24T00:00:00Z'),
    confidence: 0.9
  }
}

describe('MongoDBStorage.store — id-keyed upsert', () => {
  let storage: MongoDBStorage
  let fakeCollection: FakeCollection

  beforeEach(() => {
    storage = new MongoDBStorage({ uri: 'mongodb://fake', database: 'kms_test' } as any)
    fakeCollection = new FakeCollection()
    // Inject the fake collection directly — bypass the real initialize(),
    // which would open a live MongoDB connection. Same pattern as
    // Mem0Storage.store.timestamp.test.ts injecting a mock client.
    ;(storage as any).collection = fakeCollection
  })

  it('BUG PROOF: identical content stored under two different ids yields two id-addressable Mongo docs', async () => {
    const first = makeKnowledge('kms-id-AAA', 'The sky is blue during a clear day.')
    const second = makeKnowledge('kms-id-BBB', 'The sky is blue during a clear day.')

    await storage.store(first)
    await storage.store(second)

    // Both ids must resolve to a Mongo document with that id — this is the
    // invariant every later id-keyed op (findById/update/delete/flag) relies
    // on. Under the old contentHash-keyed upsert, the second store() would
    // match the first doc by contentHash and never insert id BBB, so this
    // assertion fails against the pre-fix code (only 1 doc, id AAA).
    expect(fakeCollection.docs).toHaveLength(2)
    const docA = await storage.findById('kms-id-AAA')
    const docB = await storage.findById('kms-id-BBB')
    expect(docA?.id).toBe('kms-id-AAA')
    expect(docB?.id).toBe('kms-id-BBB')
  })

  it('upserts on id, not contentHash, in the updateOne filter', async () => {
    const knowledge = makeKnowledge('kms-id-CCC', 'Some content to store.')
    const spy = jest.spyOn(fakeCollection, 'updateOne')

    await storage.store(knowledge)

    expect(spy).toHaveBeenCalledTimes(1)
    const [filter] = spy.mock.calls[0]
    expect(filter).toEqual({ id: 'kms-id-CCC' })
  })

  it('is idempotent: storing the exact same id twice does not create a second doc', async () => {
    const knowledge = makeKnowledge('kms-id-DDD', 'Repeat content.')

    await storage.store(knowledge)
    await storage.store(knowledge)

    expect(fakeCollection.docs).toHaveLength(1)
  })

  it('keeps contentHash as a plain field on the stored document', async () => {
    const knowledge = makeKnowledge('kms-id-EEE', 'Content with a hash.')

    await storage.store(knowledge)

    const doc = await storage.findById('kms-id-EEE')
    expect(typeof doc?.contentHash).toBe('string')
    expect((doc?.contentHash as string).length).toBeGreaterThan(0)
  })

  it('a second id with identical content is still reachable by flag/update/delete after the fix', async () => {
    const first = makeKnowledge('kms-id-FFF', 'Duplicate-content entry.')
    const second = makeKnowledge('kms-id-GGG', 'Duplicate-content entry.')
    await storage.store(first)
    await storage.store(second)

    const flagged = await storage.flag('kms-id-GGG', 'RETRACTED', 'test note')
    expect(flagged).toBe(true)

    const updated = await storage.update('kms-id-GGG', { confidence: 0.5 })
    expect(updated).toBe(true)

    const deleted = await storage.delete('kms-id-GGG')
    expect(deleted).toBe(true)

    // id AAA-equivalent (FFF) is untouched by operations scoped to GGG.
    const stillThere = await storage.findById('kms-id-FFF')
    expect(stillThere?.id).toBe('kms-id-FFF')
  })
})

describe('MongoDBStorage createIndexes — contentHash unique-index migration', () => {
  it('creates the id unique index and the non-unique contentHash replacement before dropping the legacy unique contentHash index', async () => {
    const storage = new MongoDBStorage({ uri: 'mongodb://fake', database: 'kms_test' } as any)

    const calls: string[] = []
    const fakeMainCollection = {
      createIndex: jest.fn(async (keys: any, options?: any) => {
        calls.push(`createIndex:${JSON.stringify(keys)}:${options?.name ?? JSON.stringify(options ?? {})}`)
        return 'ok'
      }),
      dropIndex: jest.fn(async (name: string) => {
        calls.push(`dropIndex:${name}`)
        return { ok: 1 }
      })
    }
    const fakeDocumentsCollection = {
      createIndex: jest.fn(async () => 'ok')
    }

    ;(storage as any).collection = fakeMainCollection
    ;(storage as any).documents = fakeDocumentsCollection

    await (storage as any).createIndexes()

    // The non-unique replacement index must be created before the legacy
    // unique index is dropped, so contentHash is never briefly unindexed.
    const replacementIdx = calls.findIndex(c => c.startsWith('createIndex:{"contentHash":1}:contentHash_1_nonunique'))
    const dropIdx = calls.findIndex(c => c === 'dropIndex:contentHash_1')
    expect(replacementIdx).toBeGreaterThanOrEqual(0)
    expect(dropIdx).toBeGreaterThanOrEqual(0)
    expect(replacementIdx).toBeLessThan(dropIdx)

    // id gets its own unique index.
    expect(fakeMainCollection.createIndex).toHaveBeenCalledWith({ id: 1 }, { unique: true, sparse: true })
  })

  it('does not throw when the legacy unique contentHash index is already gone (fresh DB / already migrated)', async () => {
    const storage = new MongoDBStorage({ uri: 'mongodb://fake', database: 'kms_test' } as any)

    const fakeMainCollection = {
      createIndex: jest.fn(async () => 'ok'),
      dropIndex: jest.fn(async () => {
        const err: any = new Error('ns not found')
        err.codeName = 'IndexNotFound'
        err.code = 27
        throw err
      })
    }
    const fakeDocumentsCollection = { createIndex: jest.fn(async () => 'ok') }

    ;(storage as any).collection = fakeMainCollection
    ;(storage as any).documents = fakeDocumentsCollection

    await expect((storage as any).createIndexes()).resolves.toBeUndefined()
    // createIndexes() swallows all errors internally (existing behavior),
    // so reaching here without the outer try/catch warning path is the
    // meaningful assertion; also confirm the sequence still ran to completion.
    expect(fakeMainCollection.dropIndex).toHaveBeenCalledWith('contentHash_1')
  })
})
