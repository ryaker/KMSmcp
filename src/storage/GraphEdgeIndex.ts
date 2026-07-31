/**
 * Whole-graph adjacency index for the SparrowDB graph backend.
 *
 * Exists because reading relationships one node at a time was both incomplete
 * and slow. The previous reader issued, per search hit, one RELATED_TO query
 * plus one ABOUT query for each of six hard-coded entity labels, which meant:
 *
 *   - Only two relationship types were ever read back. Every typed edge
 *     `unified_store` writes — SOLVES, REQUIRES, SUPERSEDES, IMPLEMENTS, and
 *     ~40 more in the live store — went into the graph and never came out.
 *   - Only outgoing edges were followed. `_createSemanticRelationships` links
 *     new → existing, so the entries everything else references had no outgoing
 *     edges and reported no relationships at all.
 *   - SparrowDB ignores a label predicate that names a label with no nodes, so
 *     `->(e:Project)` also matched Person and Technology nodes and the six-label
 *     loop returned each entity two or three times.
 *   - ~70 Cypher round-trips per search (≈7 s against the live store).
 *
 * This builds the adjacency once — one query per relationship type, a fixed
 * cost independent of result count — and then answers from memory, maintaining
 * itself incrementally as edges are created and nodes deleted.
 *
 * Kept separate from SparrowDBStorage so it can be unit-tested: that module
 * uses `import.meta.url` at the top level, which the CommonJS-mode test runner
 * cannot parse, so nothing that imports it is reachable from a test.
 */

/** The subset of the SparrowDB binding this index needs. */
export interface EdgeQueryExecutor {
  execute(cypher: string): { columns: string[]; rows: Array<Record<string, unknown>> }
}

/** Resolves a node id to its sidecar entry, for relationship content previews. */
export type EntryResolver = (id: string) => { id: string; content: string } | undefined

/** One directed edge, as seen from one of its endpoints. */
interface EdgeRef {
  type: string
  /** The id at the other end from the node this ref is keyed under. */
  other: string
  /** Strength in [0,1], or null when the edge carries no strength property. */
  strength: number | null
}

/** A relationship as returned to search callers. */
export interface GraphRelationship {
  relationship: string
  relatedNode: string
  relatedContent: string
  direction: 'outgoing' | 'incoming'
  strength: number | null
}

export interface GraphEdgeIndexOptions {
  /**
   * Cap on relationships returned for one node. Entity hub nodes (the Person
   * node that hundreds of entries are ABOUT) would otherwise dominate the MCP
   * response budget and push real results out via response truncation.
   */
  maxRelationshipsPerNode?: number
  /** Optional debug sink; defaults to no-op so this module stays dependency-free. */
  debug?: (message: string) => void
}

/** Relationship types assumed when `type(r)` discovery is unavailable. */
export const FALLBACK_RELATIONSHIP_TYPES = ['RELATED_TO', 'ABOUT']

export const DEFAULT_MAX_RELATIONSHIPS_PER_NODE = 25

/**
 * Relationship types are interpolated straight into Cypher, so anything coming
 * back from `type(r)` must be a bare identifier first. The graph holds types
 * imported from Neo4j alongside ones produced by SparrowDBStorage's sanitiser;
 * a value that somehow escaped that sanitiser must not reach the parser.
 */
const SAFE_TYPE = /^[A-Za-z_][A-Za-z0-9_]*$/

export class GraphEdgeIndex {
  private out = new Map<string, EdgeRef[]>()
  private in = new Map<string, EdgeRef[]>()
  private built = false
  private readonly maxPerNode: number
  private readonly debug: (message: string) => void

  constructor(
    private readonly db: EdgeQueryExecutor,
    private readonly resolveEntry: EntryResolver,
    options: GraphEdgeIndexOptions = {}
  ) {
    this.maxPerNode = options.maxRelationshipsPerNode ?? DEFAULT_MAX_RELATIONSHIPS_PER_NODE
    this.debug = options.debug ?? (() => {})
  }

  /** True once the adjacency has been read out of the graph. */
  get isBuilt(): boolean {
    return this.built
  }

  /**
   * Every relationship type present in the graph.
   *
   * `MATCH ()-[r]->() RETURN type(r)` is not actually distinct in this binding
   * (one row per edge), so de-duplication happens here.
   */
  discoverRelationshipTypes(): string[] {
    try {
      const result = this.db.execute(`MATCH ()-[r]->() RETURN type(r) AS rel`)
      const seen = new Set<string>()
      for (const row of result.rows) {
        const type = String(row['rel'] ?? '').trim()
        if (type && SAFE_TYPE.test(type)) seen.add(type)
      }
      if (seen.size > 0) return Array.from(seen)
    } catch (error) {
      this.debug(`type(r) discovery unavailable, using fallback types: ${error}`)
    }
    return [...FALLBACK_RELATIONSHIP_TYPES]
  }

  /** Read the adjacency out of the graph. Idempotent — a no-op once built. */
  build(): void {
    if (this.built) return

    const out = new Map<string, EdgeRef[]>()
    const inc = new Map<string, EdgeRef[]>()
    let edgeCount = 0

    for (const type of this.discoverRelationshipTypes()) {
      for (const row of this.readEdges(type)) {
        const from = row['a.id']
        const to = row['b.id']
        // A node whose id property reads back null can't be joined to a sidecar
        // entry, so an edge naming one is not addressable by any caller.
        if (from === null || from === undefined || to === null || to === undefined) continue
        const strength = decodeStrength(row['r.strength'])
        push(out, String(from), { type, other: String(to), strength })
        push(inc, String(to), { type, other: String(from), strength })
        edgeCount++
      }
    }

    this.out = out
    this.in = inc
    this.built = true
    this.debug(`edge index built: ${edgeCount} edges across ${out.size} source nodes`)
  }

  /**
   * Edges of one type. Edge properties are readable on builds that support them
   * and come back null where they aren't; if the projection itself is rejected
   * we retry without it rather than dropping the type entirely.
   */
  private readEdges(type: string): Array<Record<string, unknown>> {
    try {
      return this.db.execute(`MATCH (a)-[r:${type}]->(b) RETURN a.id, b.id, r.strength`).rows
    } catch {
      try {
        return this.db.execute(`MATCH (a)-[:${type}]->(b) RETURN a.id, b.id`).rows
      } catch (error) {
        this.debug(`skipping relationship type ${type}: ${error}`)
        return []
      }
    }
  }

  /** Discard the adjacency; the next read rebuilds it. */
  reset(): void {
    this.out = new Map()
    this.in = new Map()
    this.built = false
  }

  /**
   * Record a newly created edge rather than discarding the index. Invalidating
   * would force a full rebuild on the next search, so a store/search interleave
   * would pay the build cost over and over.
   */
  addEdge(sourceId: string, targetId: string, type: string, strength: number | null): void {
    if (!this.built) return
    push(this.out, sourceId, { type, other: targetId, strength })
    push(this.in, targetId, { type, other: sourceId, strength })
  }

  /** Drop every edge incident to `nodeId` (mirrors a DETACH DELETE). */
  removeNode(nodeId: string): void {
    if (!this.built) return
    this.out.delete(nodeId)
    this.in.delete(nodeId)
    prune(this.out, nodeId)
    prune(this.in, nodeId)
  }

  /**
   * Relationships incident to `nodeId`, outgoing first, then incoming.
   *
   * Returns [] rather than throwing when the graph is unreadable — a search hit
   * with no relationship data is degraded, but a search that fails outright is
   * broken.
   */
  relationshipsFor(nodeId: string): GraphRelationship[] {
    try {
      this.build()
    } catch (error) {
      this.debug(`edge index build failed: ${error}`)
      return []
    }

    const relationships: GraphRelationship[] = []
    const seen = new Set<string>()

    const add = (ref: EdgeRef, direction: 'outgoing' | 'incoming') => {
      if (!ref.other) return
      if (relationships.length >= this.maxPerNode) return
      // Parallel edges of the same type between the same pair are duplicates to
      // a reader, and re-storing an entry can create them.
      const key = `${direction}:${ref.type}:${ref.other}`
      if (seen.has(key)) return
      seen.add(key)
      const target = this.resolveEntry(ref.other)
      relationships.push({
        relationship: ref.type,
        relatedNode: target?.id ?? ref.other,
        relatedContent: (target?.content ?? '').slice(0, 80),
        direction,
        strength: ref.strength
      })
    }

    for (const ref of this.out.get(nodeId) ?? []) add(ref, 'outgoing')
    for (const ref of this.in.get(nodeId) ?? []) add(ref, 'incoming')

    return relationships
  }
}

function push(map: Map<string, EdgeRef[]>, key: string, ref: EdgeRef): void {
  const list = map.get(key)
  if (list) list.push(ref)
  else map.set(key, [ref])
}

function prune(map: Map<string, EdgeRef[]>, nodeId: string): void {
  for (const [key, list] of map) {
    const kept = list.filter(e => e.other !== nodeId)
    if (kept.length === 0) map.delete(key)
    else if (kept.length !== list.length) map.set(key, kept)
  }
}

/**
 * SparrowDBStorage stores strength as an integer 0–100 because SparrowDB panics
 * on float edge properties (SparrowDB#229). Undo that here.
 */
export function decodeStrength(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n / 100))
}
