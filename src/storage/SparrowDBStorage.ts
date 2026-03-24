/**
 * SparrowDB Storage System Implementation
 *
 * Drop-in replacement for Neo4jStorage — implements the same StorageSystem
 * interface plus the extended methods (getEntitySummary, getOperationalNodes,
 * getEntityCandidates, createAboutRelationships, findRelated, close) that
 * EntityLinker, UnifiedSearchTool, and UnifiedStoreTool reference directly
 * on the Neo4jStorage instance.
 *
 * Integration method: sparrowdb native Node.js binding
 *   ~/Dev/SparrowDB/npm/sparrowdb/sparrowdb.node  (NAPI, darwin-arm64)
 *
 * Known SparrowDB constraints handled here:
 *
 *   STRING TRUNCATION (current build limitation):
 *     The current sparrowdb.node binary truncates string property values to 7
 *     characters when decoding from the CSR node store. This is a bug in the
 *     NAPI value decoding path (tracked as SPA issue). Workaround: all full-
 *     length string content is stored in a JSON sidecar file (`content-index.json`)
 *     alongside the SparrowDB directory. The sidecar is loaded at startup and
 *     consulted for search. Graph structure (IDs, labels, relationships, short
 *     metadata) is stored in SparrowDB itself.
 *
 *   - Floats are bit-cast to i64 when stored via literal float syntax;
 *     workaround: store confidence as a string property.
 *   - No MERGE … SET support — upserts use DELETE + CREATE.
 *   - Relationship properties not supported — property-bearing rels
 *     stored as node properties on a synthetic node.
 *   - Variable-length path traversal ([:R*N..M]) not yet implemented;
 *     workaround: manual BFS in TypeScript.
 *   - OPTIONAL MATCH not supported — handled via separate try/catch queries.
 *   - type(r) does not work with anonymous relationship variable — use a
 *     named relationship type directly in the pattern.
 *   - CALL db.index.fulltext.createNodeIndex is not a Cypher procedure;
 *     the fulltext index requires the Rust API (create_fulltext_index +
 *     add_to_fulltext_index). These are not yet exposed to Node.js.
 *     Fulltext search falls back to in-process CONTAINS on the content sidecar.
 *
 * Environment variables:
 *   KMS_STORAGE_BACKEND=sparrowdb   (switches graph backend from Neo4j to SparrowDB)
 *   SPARROWDB_PATH=/path/to/kms.db  (default: ~/.kms-sparrowdb)
 */

import { createRequire } from 'module'
import { logger } from '../logger.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { StorageSystem, UnifiedKnowledge, KnowledgeQuery, KnownPersonEntry, KnownPeopleConfig } from '../types/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Native binding types (mirrors npm/sparrowdb/index.d.ts)
// The native module exports { SparrowDB, WriteTx, ReadTx } — SparrowDB is a
// class with a static open() method.
// ---------------------------------------------------------------------------

interface QueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
}

interface SparrowDBInstance {
  execute(cypher: string): QueryResult
  checkpoint(): void
  optimize(): void
}

interface SparrowDBClass {
  new(): SparrowDBInstance
  open(path: string): SparrowDBInstance
}

interface SparrowDBModule {
  SparrowDB: SparrowDBClass
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SparrowDBConfig {
  /** Filesystem path to the database directory.
   *  Default: $SPARROWDB_PATH env var, or ~/.kms-sparrowdb */
  dbPath?: string
}

// ---------------------------------------------------------------------------
// Content sidecar entry (full-length strings not trusted from SparrowDB)
// ---------------------------------------------------------------------------

interface ContentEntry {
  id: string
  content: string
  contentType: string
  source: string
  userId: string
  confidence: number
  timestamp: string
  metadata: Record<string, any>
}

// ---------------------------------------------------------------------------
// Load the native .node module
// ---------------------------------------------------------------------------

function loadNativeBinding(): SparrowDBModule {
  const require = createRequire(import.meta.url)
  const candidates = [
    join(homedir(), 'Dev', 'SparrowDB', 'npm', 'sparrowdb', 'sparrowdb.node'),
    join(homedir(), 'Dev', 'SparrowDB', 'target', 'release', 'sparrowdb.node'),
    join(homedir(), 'Dev', 'SparrowDB', 'target', 'debug', 'sparrowdb.node'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(p) as SparrowDBModule
    }
  }
  throw new Error(
    'SparrowDBStorage: cannot find sparrowdb.node binary.\n' +
    'Run: cargo build --release -p sparrowdb-node  in ~/Dev/SparrowDB'
  )
}

// ---------------------------------------------------------------------------
// Cypher string helpers
// SparrowDB execute() has no parameter binding — values must be embedded.
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function cypherStr(s: string): string {
  return `'${esc(s)}'`
}

function parseFloatSafe(v: unknown): number {
  if (typeof v === 'number') return isNaN(v) ? 0 : v
  if (typeof v === 'string') { const n = parseFloat(v); return isNaN(n) ? 0 : n }
  return 0
}

// ---------------------------------------------------------------------------
// SparrowDBStorage
// ---------------------------------------------------------------------------

export class SparrowDBStorage implements StorageSystem {
  public name = 'sparrowdb'
  private db!: SparrowDBInstance
  private dbPath: string
  private sidecarPath: string

  // In-process content index — keyed by knowledge id.
  // Persisted to a JSON sidecar so it survives restarts.
  private contentIndex = new Map<string, ContentEntry>()

  // Identity registry loaded from config/known-people.json.
  private knownPeople: KnownPeopleConfig | null = null

  constructor(config?: SparrowDBConfig) {
    this.dbPath =
      config?.dbPath ||
      process.env.SPARROWDB_PATH ||
      join(homedir(), '.kms-sparrowdb')
    this.sidecarPath = join(this.dbPath, 'content-index.json')
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    logger.debug(`⚡ Opening SparrowDB at ${this.dbPath}…`)
    if (!existsSync(this.dbPath)) {
      mkdirSync(this.dbPath, { recursive: true })
    }
    const native = loadNativeBinding()
    this.db = native.SparrowDB.open(this.dbPath)

    // Load content sidecar
    this._loadSidecar()

    // Load identity registry
    this._loadKnownPeople()

    logger.debug(
      `✅ SparrowDB opened — ${this.contentIndex.size} content entries in sidecar`
    )
  }

  async close(): Promise<void> {
    if (this.db) {
      this._saveSidecar()
      this.db.checkpoint()
      logger.debug('✅ SparrowDB checkpointed and sidecar saved')
    }
  }

  // -------------------------------------------------------------------------
  // StorageSystem.store
  // -------------------------------------------------------------------------

  async store(knowledge: UnifiedKnowledge): Promise<void> {
    logger.debug(`⚡ Storing in SparrowDB: ${knowledge.id}`)

    // Delete any existing node (upsert via DELETE+CREATE, since MERGE+SET is unsupported).
    try {
      this.db.execute(
        `MATCH (k:Knowledge {id: ${cypherStr(knowledge.id)}}) DELETE k`
      )
    } catch { /* node may not exist */ }

    const ts = knowledge.timestamp instanceof Date
      ? knowledge.timestamp.toISOString()
      : String(knowledge.timestamp)

    // Store the structural identity in SparrowDB.
    // Strings > 7 chars are truncated by the current binary (SPA bug), so we
    // store only the ID (≤7 chars works for most ids, but we store it anyway
    // to anchor graph structure), and keep full content in the sidecar.
    this.db.execute(
      `CREATE (k:Knowledge {` +
      `  id: ${cypherStr(knowledge.id)},` +
      `  contentType: ${cypherStr(knowledge.contentType)},` +
      `  source: ${cypherStr(knowledge.source)},` +
      `  userId: ${cypherStr(knowledge.userId ?? '')},` +
      `  confidence: ${cypherStr(String(knowledge.confidence))}` +
      `})`
    )

    // Persist full-length content in the sidecar.
    const entry: ContentEntry = {
      id: knowledge.id,
      content: knowledge.content,
      contentType: knowledge.contentType,
      source: knowledge.source,
      userId: knowledge.userId ?? '',
      confidence: knowledge.confidence,
      timestamp: ts,
      metadata: knowledge.metadata ?? {}
    }
    this.contentIndex.set(knowledge.id, entry)
    this._saveSidecar()

    // Create explicit relationships (no properties on edges — SparrowDB limitation).
    if (knowledge.relationships && knowledge.relationships.length > 0) {
      for (const rel of knowledge.relationships) {
        await this._createRelationship(knowledge.id, rel.targetId, rel.type)
      }
    }

    // Semantic auto-relationships (best-effort).
    await this._createSemanticRelationships(knowledge)

    logger.debug(
      `✅ SparrowDB stored ${knowledge.id} with ` +
      `${knowledge.relationships?.length ?? 0} relationships`
    )
  }

  // -------------------------------------------------------------------------
  // StorageSystem.search
  // -------------------------------------------------------------------------

  async search(query: KnowledgeQuery): Promise<any[]> {
    logger.debug(`🔍 Searching SparrowDB: "${query.query}"`)

    try {
      const maxResults = Math.floor(query.options?.maxResults ?? 10)
      const searchTerms = query.query.toLowerCase().trim().split(/\s+/).filter(Boolean)

      // Search is entirely in-process against the content sidecar.
      // The sidecar holds full-length strings; SparrowDB graph holds short
      // structural metadata only.
      let entries = Array.from(this.contentIndex.values())

      // Apply KnowledgeQuery filters.
      if (query.filters?.userId) {
        const uid = query.filters.userId
        entries = entries.filter(e => e.userId === uid)
      }
      if (query.filters?.source && query.filters.source.length > 0) {
        const sources = query.filters.source
        entries = entries.filter(e => sources.includes(e.source))
      }
      if (query.filters?.contentType && query.filters.contentType.length > 0) {
        const types = query.filters.contentType
        entries = entries.filter(e => types.includes(e.contentType))
      }
      if (query.filters?.minConfidence !== undefined) {
        const min = query.filters.minConfidence
        entries = entries.filter(e => e.confidence >= min)
      }

      // Score by term hits in content.
      const scored = entries
        .map(e => {
          const lower = e.content.toLowerCase()
          const hits = searchTerms.filter(t => lower.includes(t)).length
          const score = searchTerms.length > 0 ? hits / searchTerms.length : 1
          return { entry: e, score }
        })
        .filter(({ score }) => score > 0 || searchTerms.length === 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)

      // Optionally fetch graph relationships.
      const results = await Promise.all(
        scored.map(async ({ entry, score }) => {
          let relationships: any[] = []
          if (query.options?.includeRelationships) {
            relationships = await this._getRelationships(entry.id)
          }
          return {
            id: entry.id,
            content: entry.content,
            confidence: Math.min(score, 1),
            metadata: entry.metadata,
            sourceSystem: 'sparrowdb',
            timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
            contentType: entry.contentType || 'fact',
            source: entry.source || 'technical',
            nodeLabels: ['Knowledge'],
            relationships
          }
        })
      )

      logger.debug(`⚡ SparrowDB found ${results.length} results`)
      return results
    } catch (error) {
      logger.warn('⚠️ SparrowDB search error:', error)
      return []
    }
  }

  // -------------------------------------------------------------------------
  // StorageSystem.getStats
  // -------------------------------------------------------------------------

  async getStats(): Promise<Record<string, any>> {
    try {
      const nodeResult = this.db.execute(
        `MATCH (n:Knowledge) RETURN count(n)`
      )
      const totalNodes = Number(nodeResult.rows[0]?.['count(n)'] ?? 0)

      const relResult = this.db.execute(
        `MATCH ()-[r]->() RETURN count(r) AS cnt`
      )
      const totalRelationships = Number(relResult.rows[0]?.['cnt'] ?? 0)

      // Content type distribution from sidecar (authoritative — SparrowDB strings truncated).
      const contentTypes: Record<string, number> = {}
      for (const entry of this.contentIndex.values()) {
        contentTypes[entry.contentType] = (contentTypes[entry.contentType] ?? 0) + 1
      }

      return {
        totalNodes: Math.max(totalNodes, this.contentIndex.size),
        totalRelationships,
        contentTypes,
        relationshipTypes: { total: totalRelationships },
        knowledgeHubs: [],
        status: 'connected',
        graphDensity: totalNodes > 0 ? totalRelationships / totalNodes : 0,
        backend: 'sparrowdb',
        dbPath: this.dbPath,
        sidecarEntries: this.contentIndex.size
      }
    } catch (error) {
      logger.error('❌ SparrowDB stats error:', error)
      return {
        totalNodes: 0,
        totalRelationships: 0,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Extended Neo4jStorage-compatible API
  // -------------------------------------------------------------------------

  /**
   * PersonResolver — resolve any name variant to a canonical SparrowDB node ID.
   *
   * Checks (fastest → slowest):
   *   1. In-memory nameIndex from known-people.json  (O(1))
   *   2. Normalized first+last name lookup in nameIndex
   *   3. SparrowDB CONTAINS search on Person nodes
   *
   * Returns the canonical node ID, or null if no match found.
   * The caller should only create a new Person node when this returns null.
   */
  async resolvePersonId(rawName: string): Promise<string | null> {
    if (!rawName?.trim()) return null

    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
    const normalized = normalize(rawName)
    if (!normalized) return null  // e.g. input was "!!!" — would produce CONTAINS '' which matches all

    // 1. Fast in-memory lookup from known-people.json
    if (this.knownPeople) {
      const directHit = this.knownPeople.nameIndex[normalized]
      if (directHit) return directHit

      const parts = normalized.split(' ')
      if (parts.length > 2) {
        const firstLast = `${parts[0]} ${parts[parts.length - 1]}`
        const hit = this.knownPeople.nameIndex[firstLast]
        if (hit) return hit
      }
    }

    // 2. SparrowDB CONTAINS search fallback
    try {
      const safeNorm = normalized.replace(/'/g, "\\'")

      // Prefer exact normalized match first
      const exact = this.db.execute(
        `MATCH (n:Person) WHERE toLower(n.name) = '${safeNorm}' RETURN n.id LIMIT 1`
      )
      if (exact.rows.length === 1) {
        return String(exact.rows[0]['n.id'] ?? '') || null
      }

      // Partial match — only safe if exactly one result (ambiguous = skip)
      const partial = this.db.execute(
        `MATCH (n:Person) WHERE toLower(n.name) CONTAINS '${safeNorm}' RETURN n.id LIMIT 5`
      )
      if (partial.rows.length === 1) {
        const rawId = String(partial.rows[0]['n.id'] ?? '').trim()
        if (!rawId) return null
        // SparrowDB may truncate string properties to 7 chars — try to expand prefix
        if (this.knownPeople && rawId.length <= 7) {
          const matches = Object.keys(this.knownPeople.people).filter(id => id.startsWith(rawId))
          if (matches.length === 1) return matches[0]
        }
        return rawId || null
      }
    } catch (e) {
      logger.warn('⚠️ SparrowDB resolvePersonId search error:', e)
    }

    return null
  }

  async findRelated(nodeId: string, maxDepth = 2): Promise<any[]> {
    // Variable-length paths not yet implemented — manual BFS.
    try {
      const visited = new Set<string>([nodeId])
      let frontier = [nodeId]
      const results: any[] = []

      for (let depth = 1; depth <= maxDepth; depth++) {
        const next: string[] = []
        for (const id of frontier) {
          // SparrowDB only supports directed edges in MATCH patterns.
          // Query both outgoing and incoming directions separately.
          const neighbourRows: Array<Record<string, unknown>> = []
          try {
            const out = this.db.execute(
              `MATCH (a:Knowledge {id: ${cypherStr(id)}})-[:RELATED_TO]->(b:Knowledge) RETURN b.id`
            )
            neighbourRows.push(...out.rows)
          } catch { /* ignore */ }
          try {
            const inc = this.db.execute(
              `MATCH (b:Knowledge)-[:RELATED_TO]->(a:Knowledge {id: ${cypherStr(id)}}) RETURN b.id`
            )
            neighbourRows.push(...inc.rows)
          } catch { /* ignore */ }
          const neighbours = { rows: neighbourRows } as QueryResult

          for (const row of neighbours.rows) {
            const rawId = String(row['b.id'] ?? '')
            // rawId may be truncated to 7 chars — use prefix search to
            // resolve all matching sidecar entries.
            const matches = this._findAllEntriesByPrefix(rawId)
            const toProcess: ContentEntry[] = matches.length > 0
              ? matches
              : [{ id: rawId, content: '', confidence: 0, contentType: '',
                   source: '', userId: '', timestamp: '', metadata: {} }]

            for (const fullEntry of toProcess) {
              const fullId = fullEntry.id
              if (!fullId || visited.has(fullId)) continue
              visited.add(fullId)
              next.push(fullId)
              results.push({
                id: fullId,
                content: fullEntry.content,
                confidence: fullEntry.confidence,
                distance: depth,
                pathTypes: ['RELATED_TO'],
                sourceSystem: 'sparrowdb'
              })
            }
          }
        }
        frontier = next
        if (frontier.length === 0) break
      }

      return results.slice(0, 20)
    } catch (error) {
      logger.warn('⚠️ SparrowDB findRelated error:', error)
      return []
    }
  }

  async getEntitySummary(id: string): Promise<Record<string, any> | null> {
    // Check sidecar first for full content.
    const entry = this.contentIndex.get(id)

    // Try each label in the graph.
    for (const label of ['Knowledge', 'Person', 'Organization', 'Project',
                          'Technology', 'Concept', 'Service', 'Event']) {
      let result: QueryResult
      try {
        result = this.db.execute(
          `MATCH (n:${label} {id: ${cypherStr(id)}}) ` +
          `RETURN n.id, n.name, n.description, n.notes, n.headline, ` +
          `       n.profession, n.career, n.purpose, n.industry, ` +
          `       n.expertise, n.role, n.status, n.domain, n.taskPattern, ` +
          `       n.approach, n.path`
        )
      } catch { continue }
      if (result.rows.length === 0) continue

      // Strings from SparrowDB are truncated — use sidecar for content where available.
      const summary: Record<string, any> = {
        id,
        name: entry?.content?.split(' ').slice(0, 3).join(' ') ?? null,
        type: [label],
        summary: entry?.content?.slice(0, 200) ?? null,
        key_props: {} as Record<string, any>,
        top_relationships: []
      }

      // Best-effort: fetch up to 4 connected nodes.
      try {
        const rels = this.db.execute(
          `MATCH (n {id: ${cypherStr(id)}})-[:RELATED_TO]-(m) ` +
          `RETURN m.id LIMIT 4`
        )
        summary.top_relationships = rels.rows
          .map(r => {
            const mid = String(r['m.id'] ?? '')
            const related = this._findEntryByPrefix(mid)
            return related
              ? { rel: 'RELATED_TO', name: related.content.slice(0, 40), id: related.id }
              : null
          })
          .filter(Boolean)
      } catch { /* ignore */ }

      return summary
    }

    // Not in graph at all — return from sidecar only if available.
    if (entry) {
      return {
        id,
        name: null,
        type: ['Knowledge'],
        summary: entry.content.slice(0, 200),
        key_props: {},
        top_relationships: []
      }
    }
    return null
  }

  async getOperationalNodes(): Promise<Array<{
    id: string
    type: string
    name: string
    description: string
    actions: string[]
    taskPattern?: string
  }>> {
    const results: Array<{
      id: string; type: string; name: string; description: string;
      actions: string[]; taskPattern?: string
    }> = []

    for (const label of ['ContextTrigger', 'ToolRoute']) {
      try {
        const r = this.db.execute(
          `MATCH (n:${label}) ` +
          `RETURN n.id, n.type, n.name, n.description, n.taskPattern, n.actions`
        )
        for (const row of r.rows) {
          const nodeId = String(row['n.id'] ?? '')
          // Resolve full strings from sidecar.
          const entry = this._findEntryByPrefix(nodeId)
          results.push({
            id: entry?.id ?? nodeId,
            type: String(row['n.type'] ?? label),
            name: String(row['n.name'] ?? ''),
            description: String(row['n.description'] ?? row['n.taskPattern'] ?? ''),
            actions: (() => {
              try { return JSON.parse(String(row['n.actions'] ?? '[]')) } catch { return [] }
            })(),
            taskPattern: row['n.taskPattern'] ? String(row['n.taskPattern']) : undefined
          })
        }
      } catch { /* label may not exist yet */ }
    }

    return results
  }

  async getEntityCandidates(): Promise<Array<{
    id: string
    name: string
    labels: string[]
    aliases: string[]
  }>> {
    const candidates: Array<{
      id: string; name: string; labels: string[]; aliases: string[]
    }> = []

    for (const label of ['Person', 'Organization', 'Project', 'Technology', 'Concept', 'Service']) {
      try {
        const r = this.db.execute(
          `MATCH (n:${label}) RETURN n.id, n.name, n.aliases LIMIT 500`
        )
        for (const row of r.rows) {
          const rawId = String(row['n.id'] ?? '')
          if (!rawId) continue
          const entry = this._findEntryByPrefix(rawId)
          const id = entry?.id ?? rawId
          const name = String(row['n.name'] ?? entry?.content?.split(' ')[0] ?? '')
          if (!name) continue
          const aliases: string[] = (() => {
            try { return JSON.parse(String(row['n.aliases'] ?? '[]')) } catch { return [] }
          })()
          candidates.push({ id, name, labels: [label], aliases })
        }
      } catch { /* label may not exist yet */ }
    }

    return candidates.slice(0, 500)
  }

  async createAboutRelationships(
    sourceId: string,
    targetEntityIds: string[]
  ): Promise<void> {
    if (targetEntityIds.length === 0) return
    for (const targetId of targetEntityIds) {
      try {
        const src = this.db.execute(
          `MATCH (k:Knowledge {id: ${cypherStr(sourceId)}}) RETURN k.id`
        )
        if (src.rows.length === 0) continue

        // Target can be any label.
        let targetExists = false
        for (const label of ['Knowledge', 'Person', 'Organization', 'Project',
                              'Technology', 'Concept', 'Service', 'Event']) {
          try {
            const t = this.db.execute(
              `MATCH (e:${label} {id: ${cypherStr(targetId)}}) RETURN e.id`
            )
            if (t.rows.length > 0) { targetExists = true; break }
          } catch { continue }
        }
        if (!targetExists) continue

        this.db.execute(
          `MATCH (k:Knowledge {id: ${cypherStr(sourceId)}}), ` +
          `(e {id: ${cypherStr(targetId)}}) ` +
          `CREATE (k)-[:ABOUT]->(e)`
        )
      } catch (error) {
        logger.warn(`⚠️ SparrowDB createAboutRelationships ${sourceId} → ${targetId}:`, error)
      }
    }
    logger.debug(
      `⚡ SparrowDB: created ABOUT relationships: ${sourceId} → [${targetEntityIds.join(', ')}]`
    )
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Find a sidecar entry whose ID starts with the (possibly truncated) prefix.
   * Returns the first match. When multiple IDs share the same 7-char prefix,
   * disambiguation is impossible — this is a known limitation of the current
   * SparrowDB build's 7-char string truncation.
   */
  private _findEntryByPrefix(prefix: string): ContentEntry | undefined {
    if (!prefix) return undefined
    // Exact match first.
    if (this.contentIndex.has(prefix)) return this.contentIndex.get(prefix)
    // Prefix search (handles 7-char truncation from SparrowDB native binding).
    for (const [key, entry] of this.contentIndex) {
      if (key.startsWith(prefix)) return entry
    }
    return undefined
  }

  /**
   * Find ALL sidecar entries whose ID starts with the given prefix.
   * Used by findRelated to handle ambiguous 7-char truncated IDs.
   */
  private _findAllEntriesByPrefix(prefix: string): ContentEntry[] {
    if (!prefix) return []
    if (this.contentIndex.has(prefix)) {
      const e = this.contentIndex.get(prefix)
      return e ? [e] : []
    }
    const matches: ContentEntry[] = []
    for (const [key, entry] of this.contentIndex) {
      if (key.startsWith(prefix)) matches.push(entry)
    }
    return matches
  }

  private async _createRelationship(
    sourceId: string,
    targetId: string,
    relationshipType: string
  ): Promise<void> {
    try {
      const safeRelType = relationshipType.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
      this.db.execute(
        `MATCH (a:Knowledge {id: ${cypherStr(sourceId)}}), ` +
        `(b:Knowledge {id: ${cypherStr(targetId)}}) ` +
        `CREATE (a)-[:${safeRelType}]->(b)`
      )
    } catch (error) {
      logger.warn(`⚠️ SparrowDB createRelationship ${relationshipType}:`, error)
    }
  }

  private async _createSemanticRelationships(knowledge: UnifiedKnowledge): Promise<void> {
    try {
      if (knowledge.contentType !== 'insight' && knowledge.contentType !== 'relationship') return

      // Find similar nodes in sidecar (same contentType or source).
      const related = Array.from(this.contentIndex.values())
        .filter(e =>
          e.id !== knowledge.id &&
          (e.contentType === knowledge.contentType || e.source === knowledge.source)
        )
        .slice(0, 5)

      for (const rel of related) {
        await this._createRelationship(knowledge.id, rel.id, 'RELATED_TO')
      }
    } catch (error) {
      logger.warn('⚠️ SparrowDB createSemanticRelationships:', error)
    }
  }

  private async _getRelationships(nodeId: string): Promise<any[]> {
    const relationships: any[] = []
    try {
      const out = this.db.execute(
        `MATCH (a:Knowledge {id: ${cypherStr(nodeId)}})-[:RELATED_TO]->(b:Knowledge) ` +
        `RETURN b.id`
      )
      for (const row of out.rows) {
        const rawId = String(row['b.id'] ?? '')
        const target = this._findEntryByPrefix(rawId)
        relationships.push({
          relationship: 'RELATED_TO',
          relatedNode: target?.id ?? rawId,
          relatedContent: (target?.content ?? '').slice(0, 80),
          strength: null
        })
      }

      // ABOUT links to entity labels.
      for (const label of ['Person', 'Organization', 'Project', 'Technology', 'Concept', 'Service']) {
        try {
          const about = this.db.execute(
            `MATCH (k:Knowledge {id: ${cypherStr(nodeId)}})-[:ABOUT]->(e:${label}) ` +
            `RETURN e.id, e.name`
          )
          for (const row of about.rows) {
            relationships.push({
              relationship: 'ABOUT',
              relatedNode: String(row['e.id'] ?? ''),
              relatedContent: String(row['e.name'] ?? ''),
              strength: null
            })
          }
        } catch { continue }
      }
    } catch (error) {
      logger.warn('⚠️ SparrowDB _getRelationships error:', error)
    }
    return relationships.filter(r => r.relatedNode)
  }

  // -------------------------------------------------------------------------
  // Identity registry
  // -------------------------------------------------------------------------

  /**
   * Load config/known-people.json into memory.
   * Called on initialize(); silently skipped if file not yet generated.
   */
  private _loadKnownPeople(): void {
    const configPath = join(__dirname, '..', '..', 'config', 'known-people.json')
    if (!existsSync(configPath)) {
      logger.debug('config/known-people.json not found — optional; run scripts/generate-known-people.mjs to enable identity registry')
      return
    }
    try {
      this.knownPeople = null  // reset first; ensures clean state if re-called or validation fails
      const raw: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof (raw as any).nameIndex !== 'object' ||
        !(raw as any)._meta ||
        typeof (raw as any)._meta.totalPeople !== 'number'
      ) {
        throw new Error('invalid known-people.json structure')
      }
      this.knownPeople = raw as KnownPeopleConfig
      logger.debug(`✅ Identity registry loaded: ${this.knownPeople._meta.totalPeople} people, ${this.knownPeople._meta.totalNameVariants} name variants`)
    } catch (e) {
      this.knownPeople = null
      logger.warn('⚠️ Failed to load known-people.json:', e)
    }
  }

  // -------------------------------------------------------------------------
  // Sidecar persistence
  // -------------------------------------------------------------------------

  private _loadSidecar(): void {
    try {
      if (existsSync(this.sidecarPath)) {
        const raw = readFileSync(this.sidecarPath, 'utf8')
        const data: Record<string, ContentEntry> = JSON.parse(raw)
        for (const [k, v] of Object.entries(data)) {
          this.contentIndex.set(k, v)
        }
      }
    } catch (error) {
      logger.warn('⚠️ SparrowDB: failed to load content sidecar:', error)
    }
  }

  private _saveSidecar(): void {
    try {
      const data: Record<string, ContentEntry> = {}
      for (const [k, v] of this.contentIndex) {
        data[k] = v
      }
      writeFileSync(this.sidecarPath, JSON.stringify(data, null, 2), 'utf8')
    } catch (error) {
      logger.warn('⚠️ SparrowDB: failed to save content sidecar:', error)
    }
  }
}
