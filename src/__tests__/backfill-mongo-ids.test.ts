/**
 * Tests for the mongo-id-divergence backfill script (PR #132 follow-up).
 *
 * Everything under test is a pure function over in-memory arrays, or an
 * in-memory fake Mongo collection — no real Mongo, no real SparrowDB, no
 * network calls anywhere in this file.
 *
 * Coverage:
 *   - contentFingerprint matches MongoDBStorage's own (private) algorithm
 *     exactly, verified by calling the real method directly.
 *   - diffGraphAgainstMongo: already-in-Mongo / divergent / unmatched
 *     classification, per-userId bucketing, userId-scoped hash matching
 *     (no cross-user false positives), deterministic tie-break.
 *   - buildRepairDocument: shape mirrors MongoDBStorage.store()'s document,
 *     flag fields copied verbatim, defaults for missing optional fields.
 *   - formatReport: no content ever appears in the output, sample cap.
 *   - applyRepairs: additive-only, idempotent re-run via a fake collection
 *     that tracks whether {id} already exists — never modifies existing
 *     docs, upserts new ones.
 */

import {
  contentFingerprint,
  diffGraphAgainstMongo,
  buildRepairDocument,
  formatReport,
  applyRepairs,
  loadGraphEntries,
  type GraphEntryLike,
  type MongoDocLike,
  type MongoCollectionLike,
} from '../scripts/backfill-mongo-ids.js'
import { MongoDBStorage } from '../storage/MongoDBStorage.js'

function makeEntry(id: string, opts: Partial<GraphEntryLike> = {}): GraphEntryLike {
  return {
    id,
    content: `content for ${id}`,
    contentType: 'fact',
    source: 'technical',
    userId: 'eng_kms',
    confidence: 0.9,
    timestamp: '2026-04-01T00:00:00.000Z',
    metadata: { subject: 'Test.fact' },
    ...opts,
  }
}

describe('contentFingerprint', () => {
  it('matches MongoDBStorage.contentFingerprint exactly, for the same instance shape MongoDBStorage.store() uses', () => {
    // Constructing MongoDBStorage performs no I/O — its constructor is a
    // plain field assignment (see src/storage/MongoDBStorage.ts); Mongo is
    // only touched from initialize()/close(), neither called here.
    const real = new MongoDBStorage({ uri: 'unused', database: 'unused' }) as unknown as {
      contentFingerprint(content: string): string
    }

    const samples = [
      'hello world',
      '  Some Content With Mixed CASE and whitespace  \n',
      'x'.repeat(500), // exercises the 300-char slice
      '',
    ]

    for (const s of samples) {
      expect(contentFingerprint(s)).toBe(real.contentFingerprint(s))
    }
  })

  it('is a 64-char lowercase hex sha256 digest', () => {
    const hash = contentFingerprint('some content')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('normalizes case, whitespace and length the same way for equal content', () => {
    expect(contentFingerprint('Hello World')).toBe(contentFingerprint('  hello world  '))
  })
})

describe('diffGraphAgainstMongo', () => {
  it('classifies an entry already present in Mongo (by id) as alreadyInMongo', () => {
    const entry = makeEntry('graph-1')
    const mongoDocs: MongoDocLike[] = [{ id: 'graph-1', userId: 'eng_kms', contentHash: 'whatever' }]

    const diff = diffGraphAgainstMongo([entry], mongoDocs)

    expect(diff.byUserId['eng_kms']).toEqual({ total: 1, alreadyInMongo: 1, divergent: 0, unmatched: 0 })
    expect(diff.victims).toHaveLength(0)
    expect(diff.unmatchedIds).toHaveLength(0)
  })

  it('classifies an entry with no Mongo doc of its id, but a contentHash match, as a divergence victim', () => {
    const entry = makeEntry('graph-2', { content: 'shared content' })
    const oldHash = contentFingerprint('shared content')
    const mongoDocs: MongoDocLike[] = [{ id: 'old-mongo-id', userId: 'eng_kms', contentHash: oldHash }]

    const diff = diffGraphAgainstMongo([entry], mongoDocs)

    expect(diff.byUserId['eng_kms']).toEqual({ total: 1, alreadyInMongo: 0, divergent: 1, unmatched: 0 })
    expect(diff.victims).toEqual([
      { id: 'graph-2', userId: 'eng_kms', matchedMongoId: 'old-mongo-id', contentHash: oldHash },
    ])
    expect(diff.unmatchedIds).toHaveLength(0)
  })

  it('classifies an entry with no Mongo doc and no hash match as unmatched (count only)', () => {
    const entry = makeEntry('graph-3', { content: 'never routed to mongo' })
    const mongoDocs: MongoDocLike[] = [
      { id: 'unrelated', userId: 'eng_kms', contentHash: contentFingerprint('something else entirely') },
    ]

    const diff = diffGraphAgainstMongo([entry], mongoDocs)

    expect(diff.byUserId['eng_kms']).toEqual({ total: 1, alreadyInMongo: 0, divergent: 0, unmatched: 1 })
    expect(diff.victims).toHaveLength(0)
    expect(diff.unmatchedIds).toEqual(['graph-3'])
  })

  it('does NOT match a contentHash across different userIds (no cross-user false positive)', () => {
    const entry = makeEntry('graph-4', { content: 'boilerplate text', userId: 'eng_kms' })
    const hash = contentFingerprint('boilerplate text')
    // Same content, same hash, but a DIFFERENT user's Mongo doc.
    const mongoDocs: MongoDocLike[] = [{ id: 'other-users-doc', userId: 'richard_yaker', contentHash: hash }]

    const diff = diffGraphAgainstMongo([entry], mongoDocs)

    expect(diff.byUserId['eng_kms'].divergent).toBe(0)
    expect(diff.byUserId['eng_kms'].unmatched).toBe(1)
    expect(diff.victims).toHaveLength(0)
  })

  it('buckets counts per userId independently across multiple users', () => {
    const engEntry = makeEntry('e1', { userId: 'eng_kms' })
    const personalEntry = makeEntry('p1', { userId: 'richard_yaker', content: 'personal content' })
    const mongoDocs: MongoDocLike[] = [{ id: 'e1', userId: 'eng_kms', contentHash: 'irrelevant' }]

    const diff = diffGraphAgainstMongo([engEntry, personalEntry], mongoDocs)

    expect(diff.byUserId['eng_kms']).toEqual({ total: 1, alreadyInMongo: 1, divergent: 0, unmatched: 0 })
    expect(diff.byUserId['richard_yaker']).toEqual({ total: 1, alreadyInMongo: 0, divergent: 0, unmatched: 1 })
  })

  it('falls back to userId "unknown" when a graph entry has no userId', () => {
    const entry = makeEntry('e-no-user', { userId: undefined })
    const diff = diffGraphAgainstMongo([entry], [])
    expect(diff.byUserId['unknown']).toEqual({ total: 1, alreadyInMongo: 0, divergent: 0, unmatched: 1 })
  })

  it('picks the lexicographically smallest matching Mongo id deterministically when several match', () => {
    const entry = makeEntry('graph-5', { content: 'dup content' })
    const hash = contentFingerprint('dup content')
    const mongoDocs: MongoDocLike[] = [
      { id: 'zzz-old', userId: 'eng_kms', contentHash: hash },
      { id: 'aaa-old', userId: 'eng_kms', contentHash: hash },
    ]

    const diff = diffGraphAgainstMongo([entry], mongoDocs)

    expect(diff.victims[0].matchedMongoId).toBe('aaa-old')
  })
})

describe('buildRepairDocument', () => {
  it('mirrors MongoDBStorage.store()\'s document shape, including a fresh contentHash', () => {
    const entry = makeEntry('graph-6', { content: 'repair me' })
    const doc = buildRepairDocument(entry)

    expect(doc.id).toBe('graph-6')
    expect(doc.content).toBe('repair me')
    expect(doc.contentType).toBe('fact')
    expect(doc.source).toBe('technical')
    expect(doc.userId).toBe('eng_kms')
    expect(doc.metadata).toEqual({ subject: 'Test.fact' })
    expect(doc.timestamp).toEqual(new Date('2026-04-01T00:00:00.000Z'))
    expect(doc.confidence).toBe(0.9)
    expect(doc.contentHash).toBe(contentFingerprint('repair me'))
  })

  it('copies flag fields verbatim so a flagged graph entry stays flagged', () => {
    const entry = makeEntry('graph-7', {
      flag: 'SUPERSEDED',
      flag_note: 'replaced by graph-8',
      flag_date: '2026-05-01T00:00:00.000Z',
      flag_by: 'richard_yaker',
      superseded_by: 'graph-8',
    })

    const doc = buildRepairDocument(entry)

    expect(doc.flag).toBe('SUPERSEDED')
    expect(doc.flag_note).toBe('replaced by graph-8')
    expect(doc.flag_date).toEqual(new Date('2026-05-01T00:00:00.000Z'))
    expect(doc.flag_by).toBe('richard_yaker')
    expect(doc.superseded_by).toBe('graph-8')
  })

  it('omits flag fields entirely when the graph entry carries none', () => {
    const entry = makeEntry('graph-8')
    const doc = buildRepairDocument(entry)

    expect(doc.flag).toBeUndefined()
    expect(doc.flag_note).toBeUndefined()
    expect(doc.flag_date).toBeUndefined()
    expect(doc.flag_by).toBeUndefined()
    expect(doc.superseded_by).toBeUndefined()
  })

  it('defaults missing optional fields the way a malformed sidecar entry should degrade', () => {
    const entry: GraphEntryLike = { id: 'graph-9', content: 'bare entry' }
    const doc = buildRepairDocument(entry)

    expect(doc.contentType).toBe('fact')
    expect(doc.source).toBe('technical')
    expect(doc.userId).toBe('')
    expect(doc.metadata).toEqual({})
    expect(doc.confidence).toBe(0)
    expect(doc.timestamp).toBeInstanceOf(Date)
  })
})

describe('formatReport', () => {
  it('never includes entry content, only ids/userIds/counts', () => {
    const entry = makeEntry('graph-secret', { content: 'this must never appear in the report' })
    const oldHash = contentFingerprint('this must never appear in the report')
    const diff = diffGraphAgainstMongo([entry], [{ id: 'old-id', userId: 'eng_kms', contentHash: oldHash }])

    const lines = formatReport(diff).join('\n')

    expect(lines).not.toContain('this must never appear in the report')
    expect(lines).toContain('graph-secret')
    expect(lines).toContain('eng_kms')
  })

  it('caps the sample list at sampleSize', () => {
    const entries = Array.from({ length: 15 }, (_, i) => makeEntry(`g${i}`, { content: `c${i}` }))
    const mongoDocs: MongoDocLike[] = entries.map((e, i) => ({
      id: `old${i}`,
      userId: 'eng_kms',
      contentHash: contentFingerprint(e.content),
    }))

    const diff = diffGraphAgainstMongo(entries, mongoDocs)
    expect(diff.victims).toHaveLength(15)

    const lines = formatReport(diff, { sampleSize: 10 })
    const sampleLines = lines.filter((l) => l.trim().startsWith('g'))
    expect(sampleLines).toHaveLength(10)
  })

  it('reports the unmatched count without listing any unmatched ids', () => {
    const entry = makeEntry('graph-unmatched-only')
    const diff = diffGraphAgainstMongo([entry], [])

    const lines = formatReport(diff)
    expect(lines.join('\n')).toContain('Total unmatched')
    expect(lines.join('\n')).not.toContain('graph-unmatched-only')
  })
})

describe('applyRepairs', () => {
  /** In-memory fake collection: {id} is the identity, exactly like the real unique index. */
  function makeFakeCollection(seed: MongoDocLike[] = []): { collection: MongoCollectionLike; docs: Map<string, any> } {
    const docs = new Map<string, any>(seed.map((d) => [d.id, d]))
    const collection: MongoCollectionLike = {
      find: () => ({ toArray: async () => Array.from(docs.values()) }),
      updateOne: async (filter, update, options) => {
        const id = (filter as any).id
        if (docs.has(id)) {
          // Existing doc — $setOnInsert must never modify it.
          return { upsertedCount: 0, matchedCount: 1 }
        }
        if ((options as any)?.upsert) {
          const setOnInsert = (update as any).$setOnInsert
          docs.set(id, setOnInsert)
          return { upsertedCount: 1, matchedCount: 0 }
        }
        return { upsertedCount: 0, matchedCount: 0 }
      },
    }
    return { collection, docs }
  }

  it('inserts new repair docs and reports the count', async () => {
    const { collection, docs } = makeFakeCollection()
    const repairDoc = buildRepairDocument(makeEntry('graph-10', { content: 'to insert' }))

    const result = await applyRepairs(collection, [repairDoc])

    expect(result).toEqual({ inserted: 1, alreadyPresent: 0 })
    expect(docs.get('graph-10')).toEqual(repairDoc)
  })

  it('never modifies a document that already exists under that id (additive only)', async () => {
    const existing = { id: 'graph-11', content: 'DO NOT TOUCH', userId: 'eng_kms', contentHash: 'x' }
    const { collection, docs } = makeFakeCollection([existing])
    const repairDoc = buildRepairDocument(makeEntry('graph-11', { content: 'attempted overwrite' }))

    const result = await applyRepairs(collection, [repairDoc])

    expect(result).toEqual({ inserted: 0, alreadyPresent: 1 })
    expect(docs.get('graph-11')).toBe(existing) // unchanged reference, unchanged content
  })

  it('is idempotent: running twice never double-inserts or modifies the first insert', async () => {
    const { collection, docs } = makeFakeCollection()
    const repairDoc = buildRepairDocument(makeEntry('graph-12', { content: 'idempotent' }))

    const first = await applyRepairs(collection, [repairDoc])
    const second = await applyRepairs(collection, [repairDoc])

    expect(first).toEqual({ inserted: 1, alreadyPresent: 0 })
    expect(second).toEqual({ inserted: 0, alreadyPresent: 1 })
    expect(docs.size).toBe(1)
  })
})

describe('loadGraphEntries', () => {
  it('returns an empty array when the sidecar file does not exist', () => {
    expect(loadGraphEntries('/nonexistent/path/content-index.json')).toEqual([])
  })
})
