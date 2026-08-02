/**
 * Unified Search Tool - Cross-system search with FACT caching
 */

import crypto from 'crypto'
import { KnowledgeQuery } from '../types/index.js'
import { FACTCache } from '../cache/FACTCache.js'
import { MongoDBStorage, Mem0Storage } from '../storage/index.js'
import type { GraphStorage } from '../types/index.js'
import type { EvalCandidate } from '../eval/rankers.js'
import { OllamaEmbeddingService, type EmbeddingService } from '../embedding/EmbeddingService.js'
import {
  fuseWithRRF,
  isHybridRetrievalEnabled,
  VECTOR_SOURCE_SYSTEM,
} from '../retrieval/hybrid.js'

/** Shape of the KMS_EVAL_CAPTURE payload — the deduplicated, ranked pool captured
 *  before `maxResults` slicing so a ranker can be replayed offline over the same set. */
export interface EvalCapture {
  poolSize: number
  rawCount: number
  candidates: EvalCandidate[]
}

const debug = (...args: unknown[]) => { if (process.env.KMS_DEBUG) console.error(...args) }

export class UnifiedSearchTool {
  private storage: {
    mongodb: MongoDBStorage
    graph: GraphStorage
    mem0: Mem0Storage
  }
  private cache: FACTCache
  /** Injected embedder for the vector arm. Only ever touched when the hybrid flag is on. */
  private embeddingService: EmbeddingService | null
  /** Memoised lazy fallback embedder — see `getEmbeddingService()`. */
  private lazyEmbeddingService: EmbeddingService | null = null

  constructor(
    storage: { mongodb: MongoDBStorage, graph: GraphStorage, mem0: Mem0Storage },
    cache: FACTCache | null,
    embeddingService?: EmbeddingService | null
  ) {
    this.storage = storage
    this.cache = cache as FACTCache // Now using real cache
    this.embeddingService = embeddingService ?? null
  }

  /**
   * The embedder for the vector arm.
   *
   * Prefers the injected instance — sharing one instance with `UnifiedStoreTool` also
   * shares its `isAvailable()` cache, so a search does not re-probe Ollama that a store
   * just probed. Construction is otherwise deferred to first use so that every call site
   * that never enables hybrid retrieval (the CLI, every existing test) pays nothing and
   * never opens a socket.
   */
  private getEmbeddingService(): EmbeddingService | null {
    if (this.embeddingService) return this.embeddingService
    if (!this.lazyEmbeddingService) {
      try {
        this.lazyEmbeddingService = new OllamaEmbeddingService()
      } catch (e) {
        debug(`⚠️ hybrid: could not construct fallback embedder: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    }
    return this.lazyEmbeddingService
  }

  /**
   * Search across all KMS systems with intelligent caching
   * This is the main "unified_search" tool function
   */
  async search(args: {
    query: string
    filters?: {
      contentType?: string[]
      source?: string[]
      userId?: string
      minConfidence?: number
      // Subject facet (DG-FACET-A). Pure pass-through against metadata.subject.
      // String → exact match. String[] → match any. See KnowledgeQuery type.
      subject?: string | string[]
    }
    options?: {
      includeRelationships?: boolean
      maxResults?: number
      cacheStrategy?: 'aggressive' | 'conservative' | 'realtime'
      includeFlagged?: boolean
    }
  }): Promise<{
    query: string
    results: any[]
    totalFound: number
    searchTime: number
    fromCache: boolean
    sources: {
      mem0: number
      graph: number
      mongodb: number
      // Present only when KMS_HYBRID_RETRIEVAL=1 — how many candidates the vector arm
      // contributed. Expect this to be small or zero today: ~29% of the corpus is
      // embedded (806/2761 entries in the live store, counted 2026-08-01), so an empty
      // vector arm is the normal case, not a fault.
      vector?: number
    }
    performance: {
      cacheCheckTime: number
      searchTime: number
      mergingTime: number
      totalTime: number
    }
    // Context expansion — agent-friendly additions
    entity_context?: Record<string, any>   // brief cards keyed by entity ID
    triggered_actions?: Array<{            // ContextTrigger/ToolRoute matches
      id: string
      type: string
      name: string
      actions: string[]
    }>
    // Present only when KMS_EVAL_CAPTURE=1 — the deduplicated pool pre-slicing.
    _evalCapture?: EvalCapture
    // Present (and true) only when KMS_HYBRID_RETRIEVAL=1. Also persisted into the cache
    // entry so a response produced under one retrieval mode is never served to the other.
    _hybridRetrieval?: true
  }> {
    const startTime = Date.now()
    
    debug(`\n🔍 UNIFIED SEARCH Starting...`)
    debug(`📝 Query: "${args.query}"`)
    debug(`🎯 Filters: ${JSON.stringify(args.filters || {})}`)
    debug(`⚙️  Options: ${JSON.stringify(args.options || {})}`)

    const defaultUserId = process.env.KMS_DEFAULT_USER_ID || 'personal'
    const enforceUserId = (filters?: typeof args.filters) => {
      if (!filters) return { userId: defaultUserId }
      return { ...filters, userId: filters.userId || defaultUserId }
    }

    const query: KnowledgeQuery = {
      query: args.query,
      filters: enforceUserId(args.filters),
      options: {
        includeRelationships: true,
        maxResults: 10,
        cacheStrategy: 'conservative',
        includeFlagged: false,
        ...args.options
      }
    }

    // Step 1: Check cache first
    const cacheCheckStart = Date.now()
    const cacheKey = this.cache ? FACTCache.generateSearchKey(args.query, args.filters, args.options) : ''
    const cached = this.cache ? await this.cache.get<{
      results: any[]
      totalFound: number
      sources: { mem0: number, graph: number, mongodb: number, vector?: number }
      _evalCapture?: EvalCapture
      _hybridRetrieval?: true
    }>(cacheKey) : null
    const cacheCheckTime = Date.now() - cacheCheckStart
    const wantsEvalCapture = process.env.KMS_EVAL_CAPTURE === '1'
    const hybridEnabled = isHybridRetrievalEnabled()

    // A cache entry written before KMS_EVAL_CAPTURE was set (or by a run with it off)
    // has no _evalCapture. Serving it as a hit would silently hand the harness a
    // response with no candidate pool. Treat that case as a miss so the full search
    // path runs and captures fresh.
    //
    // The same argument applies to the hybrid flag, and more sharply: the cache key is a
    // hash of query+filters+options only, so a lexical-only response and a fused response
    // collide on it. Serving one for the other would make an A/B measurement of the two
    // rankers silently compare a ranker against a cached copy of its rival. Treat a
    // mode mismatch as a miss. (Entries written before this field existed have it
    // undefined, which correctly reads as "lexical".)
    const cachedIsHybrid = cached?._hybridRetrieval === true
    if (
      cached &&
      query.options?.cacheStrategy !== 'realtime' &&
      (!wantsEvalCapture || cached._evalCapture) &&
      cachedIsHybrid === hybridEnabled
    ) {
      debug(`⚡ CACHE HIT - Returning cached results`)

      return {
        query: query.query,
        results: cached.results || [],
        totalFound: cached.totalFound || 0,
        searchTime: Date.now() - startTime,
        fromCache: true,
        sources: cached.sources || { mem0: 0, graph: 0, mongodb: 0 },
        performance: {
          cacheCheckTime,
          searchTime: 0,
          mergingTime: 0,
          totalTime: Date.now() - startTime
        },
        ...(cached._evalCapture ? { _evalCapture: cached._evalCapture } : {}),
        ...(cached._hybridRetrieval ? { _hybridRetrieval: true as const } : {})
      }
    }

    debug(`💾 Cache miss - Searching all systems...`)

    // Step 2: Search across all systems in parallel
    const searchStart = Date.now()

    // The fourth (vector) arm is appended only when the flag is on, so with the flag off
    // this is the same three-way allSettled it has always been.
    const [mem0Results, graphResults, mongoResults, vectorSettled] = await Promise.allSettled([
      this.searchMem0(query),
      this.searchGraph(query),
      this.searchMongoDB(query),
      ...(hybridEnabled ? [this.searchVector(query)] : [])
    ])

    const searchTime = Date.now() - searchStart

    // Step 3: Process and merge results
    const mergingStart = Date.now()

    const processedResults = {
      mem0: mem0Results.status === 'fulfilled' ? mem0Results.value : [],
      graph: graphResults.status === 'fulfilled' ? graphResults.value : [],
      mongodb: mongoResults.status === 'fulfilled' ? mongoResults.value : [],
      // `searchVector` already swallows its own failures and returns []; this second
      // guard covers a rejection it could not anticipate. Either way the lexical arms
      // still produce a result set — a search that fails because the embedder is down
      // would be far worse than one without semantic recall.
      vector: vectorSettled?.status === 'fulfilled' ? vectorSettled.value : []
    }

    debug(`📊 Results found:`)
    debug(`   Mem0: ${processedResults.mem0.length}`)
    debug(`   Graph: ${processedResults.graph.length}`)
    debug(`   MongoDB: ${processedResults.mongodb.length}`)
    if (hybridEnabled) debug(`   Vector: ${processedResults.vector.length}`)

    // Merge all results. Vector hits join the SAME pool as the lexical ones and go
    // through deduplicateResults with them, so an item both arms found stays one
    // candidate (and, in fusion, one that scores in both ranked lists).
    const allResults = [
      ...processedResults.mem0.map(r => ({ ...r, sourceSystem: 'mem0' })),
      ...processedResults.graph.map(r => ({ ...r, sourceSystem: 'graph' })),
      ...processedResults.mongodb.map(r => ({ ...r, sourceSystem: 'mongodb' })),
      ...processedResults.vector.map(r => ({ ...r, sourceSystem: VECTOR_SOURCE_SYSTEM }))
    ]

    // Remove duplicates (same ID from different systems)
    const uniqueResults = this.deduplicateResults(allResults)

    // Sort by relevance and confidence
    const maxResults = query.options?.maxResults ?? 10
    const rankedResults = hybridEnabled
      ? this.rankResultsHybrid(uniqueResults, args.query)
      : this.rankResults(uniqueResults, args.query)
    const sortedResults = rankedResults.slice(0, maxResults)

    // Eval capture (KMS_EVAL_CAPTURE=1). Off by default and zero-cost when off.
    //
    // Why this exists: three baseline runs on 2026-08-01 measured retrieval getting
    // WORSE after two ranking changes shipped (P@5 0.54 -> 0.43), and the cause could
    // not be attributed — the ranker and the corpus had both changed, and every
    // measurement only ever saw the ranker's OWN top-N. You cannot compare two rankers
    // on a set that one of them selected.
    //
    // Capturing the deduplicated pool BEFORE slicing fixes that: any scorer can be
    // replayed over the identical candidate set offline, so ranker changes become
    // measurable instead of arguable.
    const evalCapture: EvalCapture | undefined = wantsEvalCapture
      ? {
          poolSize: uniqueResults.length,
          rawCount: allResults.length,
          candidates: rankedResults.map(r => ({
            id: r.id,
            content: r.content,
            confidence: r.confidence,
            timestamp: r.timestamp,
            contentType: r.contentType,
            sourceSystem: r.sourceSystem,
            _sourceSystems: r._sourceSystems,
            subject: r.metadata?.subject ?? null,
            extractedBy: r.metadata?.extractedBy ?? null,
            _score: r._score,
            _relevance: r._relevance,
            _recency: r._recency,
            // Hybrid signals. Emitted only under the flag so a flag-off capture is
            // byte-identical to what the harness recorded before this change. The
            // eval harness replays rankers off these fields, so the fusion has to be
            // reconstructible from the capture alone: _lexicalRank + _vectorRank + the
            // published k are exactly enough to recompute _rrf offline.
            ...(hybridEnabled ? {
              _lexicalScore: r._lexicalScore,
              _lexicalRank: r._lexicalRank,
              _vectorRank: r._vectorRank,
              _vectorSimilarity: r._vectorSimilarity,
              _rrf: r._rrf,
            } : {}),
          })),
        }
      : undefined

    const mergingTime = Date.now() - mergingStart

    // Step 4: Context expansion — entity cards + triggered actions
    // Runs AFTER merging so we know which entities surfaced before deciding what to expand.
    const { entity_context, triggered_actions } = await this.expandWithEntityContext(
      processedResults,
      args.query
    )

    // Annotate sortedResults (the actual returned set) with linkedEntityIds from entity_context.
    // expandWithEntityContext annotates processedResults items which are separate spread copies,
    // so we re-apply the annotation here on the objects that callers actually receive.
    for (const r of sortedResults) {
      const linkedIds: string[] = []
      if (r.id && entity_context[r.id]) linkedIds.push(r.id)
      const refs: string[] = r.metadata?.entityRefs || []
      for (const ref of refs) {
        if (entity_context[ref]) linkedIds.push(ref)
      }
      if (linkedIds.length > 0) r.linkedEntityIds = linkedIds
    }

    const result = {
      query: args.query,
      results: sortedResults,
      totalFound: allResults.length,
      searchTime: Date.now() - startTime,
      fromCache: false,
      sources: {
        mem0: processedResults.mem0.length,
        graph: processedResults.graph.length,
        mongodb: processedResults.mongodb.length,
        ...(hybridEnabled ? { vector: processedResults.vector.length } : {})
      },
      performance: {
        cacheCheckTime,
        searchTime,
        mergingTime,
        totalTime: Date.now() - startTime
      },
      entity_context,
      triggered_actions,
      ...(evalCapture ? { _evalCapture: evalCapture } : {}),
      ...(hybridEnabled ? { _hybridRetrieval: true as const } : {})
    }

    // Step 5: Cache the results
    if (this.cache && query.options?.cacheStrategy !== 'realtime') {
      const ttl = this.getCacheTTL(query.options?.cacheStrategy || 'conservative')
      await this.cache.set(cacheKey, result, ttl)
      debug(`💾 Results cached for ${Math.round(ttl/1000)}s`)
    }

    debug(`\n✅ UNIFIED SEARCH COMPLETE`)
    debug(`   Found: ${sortedResults.length} unique results`)
    debug(`   Entities: ${Object.keys(entity_context).length}`)
    debug(`   Triggered: ${triggered_actions.length}`)
    debug(`   Total Time: ${result.searchTime}ms`)

    return result
  }

  /**
   * Context expansion pass — runs after initial search.
   *
   * 1. Collects entity IDs from Neo4j results (Person/Organization/Project nodes)
   * 2. Collects entityRefs from MongoDB result metadata (explicit cross-links)
   * 3. Fetches brief entity summaries for all collected IDs (parallel)
   * 4. Matches ContextTrigger/ToolRoute nodes against query keywords
   *
   * Returns entity_context (brief cards keyed by ID) and triggered_actions.
   */
  private async expandWithEntityContext(
    results: { mem0: any[], graph: any[], mongodb: any[] },
    query: string
  ): Promise<{
    entity_context: Record<string, any>
    triggered_actions: Array<{ id: string, type: string, name: string, actions: string[] }>
  }> {
    // Node types that warrant an entity card — operational/system nodes are returned as triggers instead
    const ENTITY_LABELS = new Set(['Person', 'Organization', 'Project', 'Technology', 'Concept', 'Service', 'Event'])
    const OPERATIONAL_LABELS = new Set(['ContextTrigger', 'ToolRoute', 'ResourceMap', 'QueryType', 'System', 'MemoryTier'])

    // Collect entity IDs from graph results
    const entityIds = new Set<string>()
    for (const r of results.graph) {
      const labels: string[] = r.nodeLabels || []
      const hasEntityLabel = labels.some(l => ENTITY_LABELS.has(l))
      const hasOperationalLabel = labels.some(l => OPERATIONAL_LABELS.has(l))
      if (hasEntityLabel && !hasOperationalLabel && r.id) {
        entityIds.add(r.id)
      }
    }

    // Collect entityRefs from MongoDB results — these are explicit cross-links stored with procedures/lessons
    for (const r of results.mongodb) {
      const refs: string[] = r.metadata?.entityRefs || []
      for (const ref of refs) entityIds.add(ref)
    }

    // Collect entityRefs from Mem0 results too
    for (const r of results.mem0) {
      const refs: string[] = r.metadata?.entityRefs || []
      for (const ref of refs) entityIds.add(ref)
    }

    // Fetch entity summaries in parallel (cap at 6 to avoid slowdown)
    const idsToFetch = Array.from(entityIds).slice(0, 6)
    const entity_context: Record<string, any> = {}

    if (idsToFetch.length > 0) {
      const summaries = await Promise.allSettled(
        idsToFetch.map(id => this.storage.graph.getEntitySummary(id))
      )
      for (let i = 0; i < idsToFetch.length; i++) {
        const s = summaries[i]
        if (s.status === 'fulfilled' && s.value) {
          entity_context[idsToFetch[i]] = s.value
        }
      }
    }

    // Annotate each result with which entity IDs it links to (for agent consumption)
    for (const r of [...results.graph, ...results.mongodb, ...results.mem0]) {
      const linkedIds: string[] = []
      if (r.id && entity_context[r.id]) linkedIds.push(r.id)
      const refs: string[] = r.metadata?.entityRefs || []
      for (const ref of refs) {
        if (entity_context[ref]) linkedIds.push(ref)
      }
      if (linkedIds.length > 0) r.linkedEntityIds = linkedIds
    }

    // Match ContextTrigger/ToolRoute nodes against query keywords
    const triggered_actions: Array<{ id: string, type: string, name: string, actions: string[] }> = []
    try {
      const operationalNodes = await this.storage.graph.getOperationalNodes()
      const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)

      for (const node of operationalNodes) {
        const haystack = `${node.name} ${node.description} ${node.taskPattern || ''}`.toLowerCase()
        const matches = queryWords.some(word => haystack.includes(word))
        if (matches) {
          triggered_actions.push({
            id: node.id,
            type: node.type,
            name: node.name,
            actions: node.actions
          })
        }
      }
    } catch (error) {
      console.warn('⚠️ Context trigger matching failed:', error)
    }

    return { entity_context, triggered_actions }
  }

  /**
   * Search specific system
   */
  async searchSystem(
    system: 'mem0' | 'graph' | 'mongodb',
    query: KnowledgeQuery
  ): Promise<any[]> {
    debug(`🔍 Searching ${system} only...`)

    switch (system) {
      case 'mem0':
        return this.searchMem0(query)
      case 'graph':
        return this.searchGraph(query)
      case 'mongodb':
        return this.searchMongoDB(query)
      default:
        throw new Error(`Unknown system: ${system}`)
    }
  }

  /**
   * Get search recommendations based on query analysis
   */
  getSearchRecommendations(query: string): {
    recommendedSystems: string[]
    suggestedFilters: Record<string, any>
    reasoning: string
  } {
    const recommendations = {
      recommendedSystems: ['mem0', 'graph', 'mongodb'] as string[],
      suggestedFilters: {} as Record<string, any>,
      reasoning: 'Search all systems for comprehensive results'
    }

    // Analyze query to make recommendations
    const lowerQuery = query.toLowerCase()

    if (lowerQuery.includes('memory') || lowerQuery.includes('client') || lowerQuery.includes('behavior')) {
      recommendations.recommendedSystems = ['mem0', 'mongodb']
      recommendations.suggestedFilters.contentType = ['memory']
      recommendations.reasoning = 'Memory and client-related queries work best with Mem0 and MongoDB'
    } else if (lowerQuery.includes('technique') || lowerQuery.includes('relationship') || lowerQuery.includes('effective')) {
      recommendations.recommendedSystems = ['graph', 'mem0']
      recommendations.suggestedFilters.contentType = ['insight', 'relationship']
      recommendations.reasoning = 'Technique and relationship queries leverage the graph backend'
    } else if (lowerQuery.includes('config') || lowerQuery.includes('session') || lowerQuery.includes('setting')) {
      recommendations.recommendedSystems = ['mongodb', 'mem0']
      recommendations.suggestedFilters.contentType = ['fact', 'procedure']
      recommendations.reasoning = 'Configuration and session data is best found in MongoDB with Mem0 indexing'
    }

    return recommendations
  }

  // Private search methods for each system

  private async searchMem0(query: KnowledgeQuery): Promise<any[]> {
    try {
      return this.dropShardsOfFlaggedParents(await this.storage.mem0.search(query), query)
    } catch (error) {
      console.warn('⚠️ Mem0 search failed:', error instanceof Error ? error.message : String(error))
      return []
    }
  }

  /**
   * Mem0 stores an LLM-extracted fan-out of each `unified_store` write: several
   * "User described…" shards, each its own searchable row carrying
   * `metadata.kms_id` back to the KMS entry it was derived from.
   *
   * Mem0 has no flag concept, so `kms_supersede` / `kms_delete` flag the graph and
   * MongoDB copies and leave every shard live. Measured 2026-08-01: three
   * freshly-flagged parents still had 11 shards surfacing in the top-15 across six
   * queries, carrying the exact content the supersede was written to retire — a
   * retracted claim about a retrieval regression kept being served after its parent
   * was superseded. CLAUDE.md's promise that superseding a fact "stops it leaking
   * into every future session's context automatically" was false for this path.
   *
   * The shards already carry the join key, so honour the parent's flag at read time.
   * Doing it here rather than in Mem0 also covers shards written before the flag
   * existed, which no write-time fix could reach.
   */
  private dropShardsOfFlaggedParents(results: any[], query: KnowledgeQuery): any[] {
    if (query.options?.includeFlagged) return results
    const graph: any = this.storage.graph
    // Optional on the GraphStorage interface — a backend that cannot answer must not
    // cause every Mem0 result to be dropped.
    if (typeof graph?.findById !== 'function') return results

    const parentFlagged = new Map<string, boolean>()
    return results.filter(r => {
      const parentId = r?.metadata?.kms_id
      // No join key, or the shard IS the parent: nothing to inherit.
      if (!parentId || parentId === r.id) return true
      if (!parentFlagged.has(parentId)) {
        let flagged = false
        try {
          // findById returns null for a parent this backend has never seen; an unknown
          // parent is not evidence of retraction, so keep the shard either way.
          flagged = Boolean(graph.findById(parentId)?.flag)
        } catch {
          flagged = false
        }
        parentFlagged.set(parentId, flagged)
      }
      return !parentFlagged.get(parentId)
    })
  }

  private async searchGraph(query: KnowledgeQuery): Promise<any[]> {
    try {
      return await this.storage.graph.search(query)
    } catch (error) {
      console.warn('⚠️ Graph backend search failed:', error instanceof Error ? error.message : String(error))
      return []
    }
  }

  private async searchMongoDB(query: KnowledgeQuery): Promise<any[]> {
    try {
      return await this.storage.mongodb.search(query)
    } catch (error) {
      console.warn('⚠️ MongoDB search failed:', error instanceof Error ? error.message : String(error))
      return []
    }
  }

  /**
   * The vector arm (KMS_HYBRID_RETRIEVAL=1 only).
   *
   * Embeds the query and asks the graph backend's HNSW index for nearest neighbours —
   * the index that `unified_store`'s dedup gate has been populating and maintaining all
   * along, and that the read path never once consulted.
   *
   * Every failure mode here degrades to `[]`, never to a thrown error:
   *   - no `findSimilar` on the backend (older binding, non-vector graph store)
   *   - no embedder available at all
   *   - Ollama down / timing out (`isAvailable()` is a short probe, cached ~30 s)
   *   - embed throws (dim mismatch, empty query, HTTP error)
   *   - `findSimilar` throws
   * A search returning fewer results is a degradation; a search that 500s because the
   * embedder is down is an outage. Only the first is acceptable.
   *
   * An empty return is also the *expected* case for much of the corpus right now: 806 of
   * 2761 entries in the live store carry an embedder id (counted 2026-08-01, ~29%), so
   * unembedded entries simply cannot be reached by this arm and will keep arriving
   * lexically. That is a backfill gap, not a bug in this code path.
   */
  private async searchVector(query: KnowledgeQuery): Promise<any[]> {
    const graph: any = this.storage.graph

    // Optional on the GraphStorage interface — a backend without a vector index must
    // leave the lexical arms completely untouched.
    if (typeof graph?.findSimilar !== 'function') {
      debug('🧭 hybrid: graph backend exposes no findSimilar — vector arm skipped')
      return []
    }

    const embedder = this.getEmbeddingService()
    if (!embedder) {
      debug('🧭 hybrid: no embedding service — vector arm skipped')
      return []
    }

    try {
      if (typeof embedder.isAvailable === 'function' && !(await embedder.isAvailable())) {
        debug('🧭 hybrid: embedder unavailable — falling back to lexical only')
        return []
      }

      const embedding = await embedder.embed(query.query)

      const filters = query.filters ?? {}
      const userId = filters.userId || process.env.KMS_DEFAULT_USER_ID || 'personal'

      // `findSimilar` takes ONE contentType and ONE subject, while the query filters are
      // multi-valued. Push a filter down only when it is single-valued (so the HNSW
      // post-filter does the narrowing and the over-fetch budget is spent on candidates
      // that can actually survive); otherwise filter here, after retrieval.
      const contentTypes = Array.isArray(filters.contentType) ? filters.contentType : undefined
      const subjects = typeof filters.subject === 'string'
        ? [filters.subject]
        : Array.isArray(filters.subject) ? filters.subject : undefined
      // `findSimilar` has no `source` parameter at all (unlike contentType/subject, it
      // cannot be pushed down even in the single-valued case), so this is always a
      // post-filter. Without it a caller filtering on `source` would get vector hits from
      // sources it explicitly excluded — the lexical arms already honour this filter
      // (MongoDBStorage/Mem0Storage/SparrowDBStorage.search all do `$in`/equality checks
      // on `filters.source`), so the vector arm must match rather than silently ignore it.
      const sources = Array.isArray(filters.source) && filters.source.length > 0 ? filters.source : undefined

      const maxResults = query.options?.maxResults ?? 10
      // Over-fetch relative to the returned window: fusion needs enough of the vector
      // ranking to be meaningful, and a candidate the lexical arm also found consumes a
      // slot in both lists.
      const topK = Math.min(50, Math.max(10, maxResults * 2))

      const hits = await graph.findSimilar(embedding, {
        userId,
        contentType: contentTypes?.length === 1 ? contentTypes[0] : undefined,
        subject: subjects?.length === 1 ? subjects[0] : undefined,
        topK,
        includeFlagged: query.options?.includeFlagged === true
      }) as Array<{
        id: string
        similarity: number
        contentType: string
        source: string
        subject?: string
        created: string
        flag?: string | null
        content_preview: string
      }>

      if (!Array.isArray(hits) || hits.length === 0) return []

      const minConfidence = typeof filters.minConfidence === 'number' ? filters.minConfidence : undefined

      const out: any[] = []
      for (const hit of hits) {
        if (!hit || typeof hit.id !== 'string') continue
        if (contentTypes && contentTypes.length > 1 && !contentTypes.includes(hit.contentType)) continue
        if (subjects && subjects.length > 1 && !subjects.includes(hit.subject ?? '')) continue
        if (sources && !sources.includes(hit.source)) continue

        // `findSimilar` returns a 200-char preview, not the entry. Rehydrate through the
        // backend's own index so a vector-only hit is a first-class result rather than a
        // truncated stub — and so dedup's longest-content merge is not skewed by a
        // preview masquerading as the whole entry.
        const full = this.hydrateFromGraph(hit.id)

        const confidence = typeof full?.confidence === 'number' ? full.confidence : 0
        if (minConfidence !== undefined && confidence < minConfidence) continue

        out.push({
          id: hit.id,
          content: full?.content ?? hit.content_preview,
          contentType: full?.contentType ?? hit.contentType,
          source: full?.source ?? hit.source,
          timestamp: full?.timestamp ?? hit.created,
          confidence,
          metadata: full?.metadata ?? (hit.subject ? { subject: hit.subject } : {}),
          relationships: full?.relationships ?? [],
          _vectorSimilarity: Number(hit.similarity.toFixed(4))
        })
      }

      debug(`🧭 hybrid: vector arm returned ${out.length} candidate(s)`)
      return out
    } catch (error) {
      console.warn('⚠️ Vector search arm failed (continuing lexical-only):', error instanceof Error ? error.message : String(error))
      return []
    }
  }

  /**
   * Best-effort full-entry lookup for a vector hit. Synchronous on the SparrowDB
   * backend (an in-memory index read); anything else — missing method, a thenable, a
   * throw — yields null and the caller keeps the preview.
   */
  private hydrateFromGraph(id: string): any | null {
    const graph: any = this.storage.graph
    if (typeof graph?.findById !== 'function') return null
    try {
      const entry = graph.findById(id)
      if (!entry || typeof (entry as any).then === 'function') return null
      return entry
    } catch {
      return null
    }
  }

  /**
   * Remove duplicate results based on content similarity
   */
  /**
   * Collapse the same knowledge item returned by more than one backend.
   *
   * `unified_store` dual-writes an entry to graph + mem0 + mongodb under one id, so a
   * single fact routinely arrives here 2-3 times. The copies are NOT interchangeable:
   * only the graph copy carries `relationships`, and each backend reports a different
   * `confidence` — the graph's is a *lexical match score* (matchedTerms/totalTerms,
   * usually < 1) while MongoDB's is the *stored, author-assigned* confidence (usually
   * exactly 1).
   *
   * Keeping "the highest confidence copy" therefore compared two different quantities
   * and reliably discarded the graph copy — the only one with relationships. That is
   * why searches reported `sources: {graph: N}` while every returned result had
   * `relationships: []`: the graph hits were fetched, then dropped right here.
   *
   * Now the copies are MERGED rather than raced. Fields present on one backend and
   * absent on another are unioned, so relationships survive regardless of which
   * backend "wins" the scalar fields.
   */
  private deduplicateResults(results: any[]): any[] {
    const unique = new Map<string, any>()

    for (const result of results) {
      // Use ID if available, otherwise use content hash
      // Every merged/inserted entry gets a stable string id, even when the source
      // backend supplied none — callers (the eval capture in particular) join
      // candidates back to relevance labels by id, so `undefined` here makes an
      // entry silently unjoinable.
      const key = result.id || crypto.createHash('md5').update(result.content).digest('hex')
      const existing = unique.get(key)

      if (!existing) {
        unique.set(key, result.id ? result : { ...result, id: key })
        continue
      }

      // Prefer the longer content — a backend may store a truncated projection.
      const base = (result.content?.length ?? 0) > (existing.content?.length ?? 0) ? result : existing
      const other = base === result ? existing : result

      const merged: any = { ...other, ...base, id: base.id || other.id || key }

      // Union the fields that only some backends populate, preferring whichever
      // copy actually has them rather than whichever copy won on content length.
      const rels = (base.relationships?.length ? base.relationships : other.relationships) ?? []
      if (rels.length) merged.relationships = rels

      // entityRefs drive downstream entity-context linking (search()'s linkedEntityIds
      // annotation and expandWithEntityContext). Union them the same way as relationships,
      // or whichever copy loses on content length silently drops its refs.
      //
      // metadata itself is merged unconditionally (not only when entityRefs is
      // non-empty) — subject/extractedBy are per-copy fields too, and the eval capture
      // reads them straight off this merged object. Merging only on the entityRefs
      // branch meant a subject/extractedBy present solely on the losing copy was
      // dropped whenever neither copy had entityRefs.
      const entityRefs = Array.from(new Set([
        ...(base.metadata?.entityRefs ?? []),
        ...(other.metadata?.entityRefs ?? []),
      ]))
      merged.metadata = { ...other.metadata, ...base.metadata }
      if (entityRefs.length) merged.metadata.entityRefs = entityRefs

      // Keep the stored confidence (the author's), not a per-backend match score.
      merged.confidence = Math.max(base.confidence ?? 0, other.confidence ?? 0)

      // Record every backend this item came from — previously the surviving copy
      // claimed a single source, which made `sources` counts unreconcilable with
      // the returned set.
      const sourceSystems = new Set<string>([
        ...(base._sourceSystems ?? [base.sourceSystem]),
        ...(other._sourceSystems ?? [other.sourceSystem]),
      ].filter(Boolean))
      merged._sourceSystems = Array.from(sourceSystems)

      unique.set(key, merged)
    }

    return Array.from(unique.values())
  }

  /**
   * Rank results by a composite relevance score.
   *
   * The previous implementation sorted by `confidence` FIRST and only fell through
   * to text relevance when two results differed by more than 0.1. Every stored entry
   * carries confidence 1 (it is the author's stated confidence in the fact, not a
   * retrieval score), so that branch never fired and the tie-breaker did all the work
   * unaided — while genuinely irrelevant entries that happened to share a word with
   * the query ranked alongside exact topical matches.
   *
   * Scoring is now explicit and inspectable: lexical relevance, recency, and a small
   * confidence contribution, combined into `_score` and attached to each result so a
   * caller can see WHY something ranked where it did.
   */
  private rankResults(results: any[], query: string): any[] {
    const scored = results.map(r => {
      const relevance = this.calculateRelevance(r.content, query)
      const recency = this.calculateRecency(r.timestamp)
      // Relevance dominates; recency breaks ties between comparably relevant hits
      // (memory is corrected over time, so newer entries about the same topic usually
      // supersede older ones). Confidence contributes only marginally — it is nearly
      // always 1 and carries almost no ranking signal.
      const score = relevance * 0.70 + recency * 0.25 + (r.confidence ?? 0) * 0.05
      return { ...r, _score: Number(score.toFixed(4)), _relevance: Number(relevance.toFixed(4)), _recency: Number(recency.toFixed(4)) }
    })
    return scored.sort((a, b) => b._score - a._score)
  }

  /**
   * Hybrid ranking (KMS_HYBRID_RETRIEVAL=1 only) — Reciprocal Rank Fusion of the lexical
   * ordering and the vector ordering.
   *
   * The lexical composite is computed exactly as `rankResults` computes it, but it is no
   * longer the final score: it becomes the lexical arm's *ranking key*, published as
   * `_lexicalScore`. Fusion then works on ranks, because the two arms' scores are not on
   * a comparable scale (see `src/retrieval/hybrid.ts` for the full argument).
   *
   * `_score` is set to the fused value so that the value the service ordered by is the
   * value the eval harness's `shippedRanker` re-sorts by — otherwise the harness would
   * silently replay the lexical ordering and report it as the shipped one.
   */
  private rankResultsHybrid(results: any[], query: string): any[] {
    const scored = results.map(r => {
      const relevance = this.calculateRelevance(r.content, query)
      const recency = this.calculateRecency(r.timestamp)
      const lexicalScore = relevance * 0.70 + recency * 0.25 + (r.confidence ?? 0) * 0.05
      return {
        ...r,
        _relevance: Number(relevance.toFixed(4)),
        _recency: Number(recency.toFixed(4)),
        _lexicalScore: Number(lexicalScore.toFixed(4))
      }
    })

    return fuseWithRRF(scored).map(r => ({ ...r, _score: r._rrf }))
  }

  /**
   * Lexical relevance of content to the query, in [0, 1].
   *
   * Word-boundary matched rather than substring matched: the old `includes(term)`
   * scored an insurance doc about a *session* timeout as relevant to a query about
   * an *Ollama* timeout, because "timeout" appeared somewhere in the text. Coverage
   * (what fraction of query terms appear at all) is the dominant signal, with bounded
   * bonuses for repetition and for the full query appearing as a phrase.
   */
  private calculateRelevance(content: string, query: string): number {
    if (!content || !query) return 0

    const contentLower = content.toLowerCase()
    const queryLower = query.trim().toLowerCase()
    // Drop stopwords and 1-char fragments so common filler does not inflate coverage.
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'is', 'it'])
    const terms = Array.from(new Set(
      queryLower.split(/[^a-z0-9_.-]+/).filter(t => t.length > 1 && !STOP.has(t))
    ))
    if (terms.length === 0) return 0

    let matched = 0
    let density = 0
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Bounded on BOTH sides. A leading \b alone still prefix-matches, so "timeout"
      // would score against "timeoutvalue" — the substring defect this function exists
      // to remove, in its prefix form.
      //
      // A short inflectional suffix is allowed so "timeout" matches "timeouts" and
      // "abort" matches "aborted"; that is real recall, not accidental overlap. Terms
      // ending in "e" get that "e" made optional so "route" also reaches "routing"
      // (rout + ing). Anything beyond these suffixes must clear its own word boundary.
      const stem = escaped.endsWith('e') ? `${escaped.slice(0, -1)}e?` : escaped
      const occurrences = (contentLower.match(new RegExp(`\\b${stem}(?:s|es|ed|ing)?\\b`, 'g')) || []).length
      if (occurrences > 0) {
        matched++
        // Diminishing returns — a term repeated 20x is not 20x more relevant.
        density += Math.min(occurrences, 5) / 5
      }
    }

    const coverage = matched / terms.length          // how much of the query is present
    const densityScore = density / terms.length      // how emphatically

    // Phrase bonus must be word-boundary matched too. A plain includes() would fire on
    // "value" inside "timeoutvalue" — the same substring bug this rewrite exists to fix,
    // reintroduced one line lower.
    let phraseBonus = 0
    if (queryLower.length > 3) {
      const escapedPhrase = queryLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\b${escapedPhrase}\\b`).test(contentLower)) phraseBonus = 0.15
    }

    const raw = Math.min(1, coverage * 0.7 + densityScore * 0.15 + phraseBonus)

    // Length normalisation. Without it, long multi-topic entries dominate unrelated
    // queries: a 3,000-char "everything I did today" note is keyword-dense enough to
    // contain an incidental hit for almost any query, and if it is also recent it
    // scores near-maximum on recency too — so it parks at the top of searches it has
    // nothing to do with. A retrieval baseline over 20 real queries (P@5 0.54) named
    // this as one of four causes.
    //
    // Damping is deliberately gentle and floored at 0.6: length correlates with
    // substance as well as with noise, and a hard penalty would bury genuinely
    // detailed entries. A ~500-char entry is unpenalised; the floor activates at
    // ~2,321 chars, past which every length flattens to the same 0.6 factor — a
    // 3,000-char entry already sits on that floor, a 40% reduction, enough to
    // lose a tie to a short exact match without being excluded.
    const len = content.length
    const NEUTRAL_LEN = 500
    const damping = len <= NEUTRAL_LEN
      ? 1
      : Math.max(0.6, 1 / (1 + Math.log10(len / NEUTRAL_LEN)))

    return raw * damping
  }

  /**
   * Recency weight in [0, 1] with a 90-day half-life.
   *
   * Stored knowledge is corrected over time — today's entry about a subject usually
   * supersedes April's. Ranking previously ignored timestamps entirely, so stale
   * entries interleaved with current ones on the same topic.
   */
  private calculateRecency(timestamp?: string | number | Date): number {
    if (!timestamp) return 0.5   // unknown age — neutral, neither boosted nor buried
    const t = new Date(timestamp).getTime()
    if (!Number.isFinite(t)) return 0.5
    const ageDays = (Date.now() - t) / 86_400_000
    if (ageDays < 0) return 1    // clock skew / future-dated
    const HALF_LIFE_DAYS = 90
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
  }

  /**
   * Get cache TTL based on strategy
   */
  private getCacheTTL(strategy: 'aggressive' | 'conservative' | 'realtime'): number {
    switch (strategy) {
      case 'aggressive': return 3600000   // 1 hour
      case 'conservative': return 1800000 // 30 minutes  
      case 'realtime': return 0           // No caching
      default: return 1800000
    }
  }
}
