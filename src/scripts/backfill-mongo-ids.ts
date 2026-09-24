/**
 * backfill-mongo-ids.ts (mongo-id-divergence repair, PR #132 follow-up)
 *
 * Why this exists
 * ================
 * Before PR #132 (commit 58b57db8), `MongoDBStorage.store()` upserted on
 * `contentHash` instead of `id`. When identical content was written again
 * under a NEW KMS id — a legitimate, non-deduped write, since Tier 0/1 dedup
 * lives upstream in UnifiedStoreTool, not here — Mongo's upsert matched the
 * OLD document by contentHash and kept the OLD id, while SparrowDB (graph)
 * and Mem0 both stored the NEW id. Every later id-scoped operation on the new
 * id (flag/update/delete/supersede, or a plain findById) then missed Mongo
 * entirely: `matchedCount`/`deletedCount` came back 0.
 *
 * The result: some graph entries that were routed to Mongo have NO Mongo
 * document carrying their own `id`. Their content exists in Mongo, but under
 * a different (older) id. This script finds those "divergence victims" and
 * repairs Mongo additively — it inserts a document under the graph entry's
 * own id, without touching the old document or any graph/Mem0 data.
 *
 * What it does
 * ============
 *  1. Reads every graph entry from the SparrowDB content-index.json sidecar
 *     (the same file SparrowDBStorage's in-memory contentIndex loads from —
 *     see `_loadSidecar()` in src/storage/SparrowDBStorage.ts — and the same
 *     file `kms export` reads for full-length content, src/cli/kms.ts). This
 *     sidecar already carries every userId's entries; there is no separate
 *     per-userId store to query.
 *  2. Reads every Mongo `unified_knowledge` document (id, userId, contentHash
 *     only — never full content, so a dry-run report can never leak it).
 *  3. For each graph entry with no Mongo doc of the same `id`, checks whether
 *     a Mongo doc exists (same userId) whose `contentHash` equals the hash
 *     MongoDBStorage.store() would compute for the entry's content. Reuses
 *     the actual private `contentFingerprint` method off a throwaway
 *     MongoDBStorage instance (constructing one performs no I/O — see
 *     `fingerprintHost` below) so this script's hashes can never drift from
 *     production's.
 *  4. Matches are "divergence victims": for each, builds a Mongo document the
 *     same way `MongoDBStorage.store()` does — `{ ...knowledge, contentHash }`
 *     — copying the graph entry's flag fields too, so a flagged entry stays
 *     flagged, then inserts it keyed on the graph entry's own id via
 *     `updateOne({ id }, { $setOnInsert: doc }, { upsert: true })`. Re-runs
 *     are idempotent: an id that already exists is left untouched.
 *  5. Entries with no Mongo doc and no hash match are reported as a count
 *     only (item 6) — they may simply never have been routed to Mongo by the
 *     storage router, which is expected, not a defect this script repairs.
 *
 * ADDITIVE ONLY. This script never deletes or modifies an existing Mongo
 * document, and never touches graph or Mem0 data at all.
 *
 * Run
 * ===
 *   # Dry-run (counts + up to 10 sample ids, no writes) — eng:
 *   doppler run --project ry-local --config dev_eng -- \
 *     npx tsx src/scripts/backfill-mongo-ids.ts
 *
 *   # Dry-run — personal:
 *   doppler run --project ry-local --config dev_personal -- \
 *     npx tsx src/scripts/backfill-mongo-ids.ts
 *
 *   # Apply (persist repair inserts) — eng:
 *   doppler run --project ry-local --config dev_eng -- \
 *     npx tsx src/scripts/backfill-mongo-ids.ts --apply
 *
 *   # Apply — personal:
 *   doppler run --project ry-local --config dev_personal -- \
 *     npx tsx src/scripts/backfill-mongo-ids.ts --apply
 *
 * Environment (matches src/index.ts ~1388 exactly, so this script always
 * points at the same database the live MCP server does):
 *   MONGODB_ATLAS_URI || MONGODB_URI   — Mongo connection string
 *   MONGODB_DATABASE                    — database name (default 'unified_kms')
 *   SPARROWDB_PATH                      — SparrowDB root (default via
 *                                          resolveSparrowDBPath())
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'

import { resolveSparrowDBPath } from '../storage/sparrowDbPath.js'
import { MongoDBStorage } from '../storage/MongoDBStorage.js'
import type { KnowledgeFlag } from '../types/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of every entry inside content-index.json (mirrors SparrowDBStorage's ContentEntry). */
export interface GraphEntryLike {
  id: string
  content: string
  contentType?: string
  source?: string
  userId?: string
  confidence?: number
  timestamp?: string
  metadata?: Record<string, unknown>
  flag?: KnowledgeFlag | null
  flag_note?: string
  flag_date?: string
  flag_by?: string
  superseded_by?: string
  [key: string]: unknown
}

/** The minimal projection this script ever reads off a Mongo `unified_knowledge` doc. */
export interface MongoDocLike {
  id: string
  userId?: string
  contentHash?: string
}

/** The document this script inserts — built the same way MongoDBStorage.store() builds one. */
export interface MongoRepairDoc {
  id: string
  content: string
  contentType: string
  source: string
  userId: string
  metadata: Record<string, unknown>
  timestamp: Date
  confidence: number
  contentHash: string
  flag?: KnowledgeFlag | null
  flag_note?: string
  flag_date?: Date
  flag_by?: string
  superseded_by?: string
}

/** A graph entry whose content already lives in Mongo, but under a different id. */
export interface DivergenceVictim {
  id: string
  userId: string
  matchedMongoId: string
  contentHash: string
}

export interface UserIdCounts {
  total: number
  alreadyInMongo: number
  /** Repairable — a Mongo doc with matching contentHash exists under a different id. */
  divergent: number
  /** No Mongo doc of this id, and no contentHash match — likely never routed to Mongo. */
  unmatched: number
}

export interface DiffResult {
  byUserId: Record<string, UserIdCounts>
  victims: DivergenceVictim[]
  /** ids only, for the count in item 6 — never printed with content. */
  unmatchedIds: string[]
}

/** Minimal subset of the Mongo `Collection` API this script uses. Lets tests fake it entirely. */
export interface MongoCollectionLike {
  find(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>
  ): { toArray(): Promise<MongoDocLike[]> }
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<{ upsertedCount?: number; matchedCount?: number }>
}

// ---------------------------------------------------------------------------
// contentFingerprint — reused from MongoDBStorage, not reimplemented
// ---------------------------------------------------------------------------

// MongoDBStorage.contentFingerprint is a private method — it's the exact
// hashing algorithm store() uses to decide what "same content" means. Rather
// than copy its implementation (and risk silent drift if it ever changes),
// this calls the real method off a throwaway instance. Constructing
// MongoDBStorage does no I/O: its constructor is `constructor(private
// config) {}` (src/storage/MongoDBStorage.ts) and only ever talks to Mongo
// from initialize()/close(), neither of which is called here. `uri`/`database`
// are never used by contentFingerprint, so placeholder values are safe.
const fingerprintHost = new MongoDBStorage({ uri: 'unused', database: 'unused' }) as unknown as {
  contentFingerprint(content: string): string
}

export function contentFingerprint(content: string): string {
  return fingerprintHost.contentFingerprint(content)
}

// ---------------------------------------------------------------------------
// Pure diff / repair logic — no I/O, fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Compare every graph entry against every Mongo doc and classify each graph
 * entry as: already in Mongo under its own id, a divergence victim (repair
 * candidate), or unmatched (no doc under its id, and no contentHash match).
 *
 * A Mongo doc is only treated as a divergence victim's match when its
 * `userId` also matches the graph entry's `userId` — contentHash alone is a
 * hash of content only, and two different users writing identical content
 * (a boilerplate string, say) should never be repaired into each other's
 * history. When more than one Mongo doc shares the (userId, contentHash)
 * pair, the lexicographically smallest id is picked, purely for determinism.
 */
export function diffGraphAgainstMongo(
  graphEntries: GraphEntryLike[],
  mongoDocs: MongoDocLike[]
): DiffResult {
  const mongoIds = new Set(mongoDocs.map((d) => d.id))

  // key: `${userId}::${contentHash}` -> candidate docs
  const hashIndex = new Map<string, MongoDocLike[]>()
  for (const doc of mongoDocs) {
    if (!doc.contentHash) continue
    const key = `${doc.userId ?? ''}::${doc.contentHash}`
    const list = hashIndex.get(key)
    if (list) list.push(doc)
    else hashIndex.set(key, [doc])
  }

  const byUserId: Record<string, UserIdCounts> = {}
  const victims: DivergenceVictim[] = []
  const unmatchedIds: string[] = []

  for (const entry of graphEntries) {
    const userId = entry.userId ?? 'unknown'
    const counts = byUserId[userId] ?? { total: 0, alreadyInMongo: 0, divergent: 0, unmatched: 0 }
    byUserId[userId] = counts
    counts.total++

    if (mongoIds.has(entry.id)) {
      counts.alreadyInMongo++
      continue
    }

    const hash = contentFingerprint(entry.content ?? '')
    const candidates = hashIndex.get(`${userId}::${hash}`)
    if (candidates && candidates.length > 0) {
      const matched = [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0]
      counts.divergent++
      victims.push({ id: entry.id, userId, matchedMongoId: matched.id, contentHash: hash })
    } else {
      counts.unmatched++
      unmatchedIds.push(entry.id)
    }
  }

  return { byUserId, victims, unmatchedIds }
}

/**
 * Build the Mongo document for a divergence victim, the same way
 * MongoDBStorage.store() builds one: `{ ...knowledge, contentHash }`. Flag
 * fields are copied verbatim so a flagged graph entry stays flagged in Mongo.
 */
export function buildRepairDocument(entry: GraphEntryLike): MongoRepairDoc {
  const contentHash = contentFingerprint(entry.content ?? '')
  const doc: MongoRepairDoc = {
    id: entry.id,
    content: entry.content ?? '',
    contentType: entry.contentType ?? 'fact',
    source: entry.source ?? 'technical',
    userId: entry.userId ?? '',
    metadata: entry.metadata ?? {},
    timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
    confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
    contentHash,
  }
  if (entry.flag !== undefined) doc.flag = entry.flag
  if (entry.flag_note !== undefined) doc.flag_note = entry.flag_note
  if (entry.flag_date !== undefined) doc.flag_date = new Date(entry.flag_date)
  if (entry.flag_by !== undefined) doc.flag_by = entry.flag_by
  if (entry.superseded_by !== undefined) doc.superseded_by = entry.superseded_by
  return doc
}

/**
 * Format a DiffResult as human-readable report lines. No content, no
 * secrets — only ids, userIds and counts.
 */
export function formatReport(diff: DiffResult, opts: { sampleSize?: number } = {}): string[] {
  const sampleSize = opts.sampleSize ?? 10
  const lines: string[] = []

  lines.push('Per-userId counts:')
  const userIds = Object.keys(diff.byUserId).sort()
  if (userIds.length === 0) {
    lines.push('  (no graph entries found)')
  }
  for (const userId of userIds) {
    const c = diff.byUserId[userId]
    lines.push(
      `  ${userId}: total=${c.total}  alreadyInMongo=${c.alreadyInMongo}  ` +
        `divergent(repairable)=${c.divergent}  unmatched(count-only)=${c.unmatched}`
    )
  }

  lines.push('')
  lines.push(`Total repairable (divergence victims): ${diff.victims.length}`)
  lines.push(
    `Total unmatched (no Mongo doc, no hash match — likely never routed to Mongo): ${diff.unmatchedIds.length}`
  )

  if (diff.victims.length > 0) {
    lines.push('')
    lines.push(`Sample repairable ids (up to ${sampleSize}, no content):`)
    for (const v of diff.victims.slice(0, sampleSize)) {
      lines.push(`  ${v.id}  (userId=${v.userId}, matchedMongoId=${v.matchedMongoId})`)
    }
  }

  return lines
}

/**
 * Insert every repair doc via `updateOne({id}, {$setOnInsert}, {upsert:true})`
 * — additive only, and idempotent: an id already present is left untouched
 * (upsertedCount 0), never modified.
 */
export async function applyRepairs(
  collection: MongoCollectionLike,
  docs: MongoRepairDoc[],
  log: (msg: string) => void = () => {}
): Promise<{ inserted: number; alreadyPresent: number }> {
  let inserted = 0
  let alreadyPresent = 0
  for (const doc of docs) {
    const result = await collection.updateOne(
      { id: doc.id },
      { $setOnInsert: doc },
      { upsert: true }
    )
    if ((result.upsertedCount ?? 0) > 0) {
      inserted++
      log(`  + inserted ${doc.id}`)
    } else {
      alreadyPresent++
    }
  }
  return { inserted, alreadyPresent }
}

// ---------------------------------------------------------------------------
// I/O — sidecar + Mongo reads, gated behind CLI entry
// ---------------------------------------------------------------------------

/** Read every graph entry from the SparrowDB content-index.json sidecar. */
export function loadGraphEntries(sidecarPath: string): GraphEntryLike[] {
  if (!existsSync(sidecarPath)) return []
  try {
    const raw = readFileSync(sidecarPath, 'utf8')
    const data = JSON.parse(raw) as Record<string, GraphEntryLike>
    return Object.values(data)
  } catch (error) {
    console.warn(`⚠️  Failed to parse sidecar at ${sidecarPath}:`, error)
    return []
  }
}

/** Read every Mongo `unified_knowledge` doc's id/userId/contentHash. */
export async function loadAllMongoDocs(collection: MongoCollectionLike): Promise<MongoDocLike[]> {
  const cursor = collection.find(
    {},
    { projection: { _id: 0, id: 1, userId: 1, contentHash: 1 } }
  )
  return cursor.toArray()
}

async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply')

  const sparrowdbPath = resolveSparrowDBPath()
  const sidecarPath = join(sparrowdbPath, 'content-index.json')

  const mongoUri = process.env.MONGODB_ATLAS_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017'
  const mongoDatabase = process.env.MONGODB_DATABASE || 'unified_kms'

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  KMS Mongo-id divergence backfill (PR #132 follow-up)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log(`  SparrowDB sidecar: ${sidecarPath}`)
  console.log(`  Mongo database:    ${mongoDatabase}`)
  console.log(`  Mode:              ${apply ? 'APPLY (writing inserts)' : 'DRY-RUN (no writes)'}`)
  console.log('')

  const graphEntries = loadGraphEntries(sidecarPath)
  if (graphEntries.length === 0) {
    console.log(`⚠️  No graph entries found at ${sidecarPath} — nothing to do.`)
    return 0
  }

  const client = new MongoClient(mongoUri)
  await client.connect()
  try {
    const db = client.db(mongoDatabase)
    const collection = db.collection('unified_knowledge') as unknown as MongoCollectionLike

    const mongoDocs = await loadAllMongoDocs(collection)
    const diff = diffGraphAgainstMongo(graphEntries, mongoDocs)

    for (const line of formatReport(diff)) console.log(line)

    if (diff.victims.length === 0) {
      console.log('')
      console.log('✅ No divergence victims found — nothing to repair.')
      return 0
    }

    if (!apply) {
      console.log('')
      console.log('💡 Re-run with --apply to persist the repair inserts. (No writes performed in this run.)')
      return 0
    }

    console.log('')
    console.log(`✏️  Applying ${diff.victims.length} repair insert(s)...`)
    const entryById = new Map(graphEntries.map((e) => [e.id, e]))
    const docs = diff.victims
      .map((v) => entryById.get(v.id))
      .filter((e): e is GraphEntryLike => !!e)
      .map(buildRepairDocument)

    const result = await applyRepairs(collection, docs, (m) => console.log(m))
    console.log('')
    console.log(`✅ Inserted ${result.inserted}, already present ${result.alreadyPresent}.`)

    return 0
  } finally {
    await client.close()
  }
}

// Detect CLI invocation. The compiled file lives at dist/scripts/...; we run
// only when this module is the entrypoint, not when a test imports it.
const isCli = (() => {
  try {
    const argv1 = process.argv[1] ?? ''
    return argv1.includes('backfill-mongo-ids')
  } catch {
    return false
  }
})()

if (isCli) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('❌ backfill-mongo-ids failed:', error)
      process.exit(1)
    })
}
