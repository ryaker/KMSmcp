/**
 * Unified Search Tool - Cross-system search with FACT caching
 */

import crypto from 'crypto'
import { KnowledgeQuery } from '../types/index.js'
import { FACTCache } from '../cache/FACTCache.js'
import { MongoDBStorage, Mem0Storage } from '../storage/index.js'
import type { GraphStorage } from '../types/index.js'

const debug = (...args: unknown[]) => { if (process.env.KMS_DEBUG) console.error(...args) }

export class UnifiedSearchTool {
  private storage: {
    mongodb: MongoDBStorage
    graph: GraphStorage
    mem0: Mem0Storage
  }
  private cache: FACTCache

  constructor(
    storage: { mongodb: MongoDBStorage, graph: GraphStorage, mem0: Mem0Storage },
    cache: FACTCache | null
  ) {
    this.storage = storage
    this.cache = cache as FACTCache // Now using real cache
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
      sources: { mem0: number, graph: number, mongodb: number }
    }>(cacheKey) : null
    const cacheCheckTime = Date.now() - cacheCheckStart
    
    if (cached && query.options?.cacheStrategy !== 'realtime') {
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
        }
      }
    }

    debug(`💾 Cache miss - Searching all systems...`)

    // Step 2: Search across all systems in parallel
    const searchStart = Date.now()

    const [mem0Results, graphResults, mongoResults] = await Promise.allSettled([
      this.searchMem0(query),
      this.searchGraph(query),
      this.searchMongoDB(query)
    ])

    const searchTime = Date.now() - searchStart

    // Step 3: Process and merge results
    const mergingStart = Date.now()

    const processedResults = {
      mem0: mem0Results.status === 'fulfilled' ? mem0Results.value : [],
      graph: graphResults.status === 'fulfilled' ? graphResults.value : [],
      mongodb: mongoResults.status === 'fulfilled' ? mongoResults.value : []
    }

    debug(`📊 Results found:`)
    debug(`   Mem0: ${processedResults.mem0.length}`)
    debug(`   Graph: ${processedResults.graph.length}`)
    debug(`   MongoDB: ${processedResults.mongodb.length}`)

    // Merge all results
    const allResults = [
      ...processedResults.mem0.map(r => ({ ...r, sourceSystem: 'mem0' })),
      ...processedResults.graph.map(r => ({ ...r, sourceSystem: 'graph' })),
      ...processedResults.mongodb.map(r => ({ ...r, sourceSystem: 'mongodb' }))
    ]

    // Remove duplicates (same ID from different systems)
    const uniqueResults = this.deduplicateResults(allResults)

    // Sort by relevance and confidence
    const maxResults = query.options?.maxResults ?? 10
    const sortedResults = this.rankResults(uniqueResults, args.query)
      .slice(0, maxResults)

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
        mongodb: processedResults.mongodb.length
      },
      performance: {
        cacheCheckTime,
        searchTime,
        mergingTime,
        totalTime: Date.now() - startTime
      },
      entity_context,
      triggered_actions
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
      return await this.storage.mem0.search(query)
    } catch (error) {
      console.warn('⚠️ Mem0 search failed:', error instanceof Error ? error.message : String(error))
      return []
    }
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
      const key = result.id || crypto.createHash('md5').update(result.content).digest('hex')
      const existing = unique.get(key)

      if (!existing) {
        unique.set(key, result)
        continue
      }

      // Prefer the longer content — a backend may store a truncated projection.
      const base = (result.content?.length ?? 0) > (existing.content?.length ?? 0) ? result : existing
      const other = base === result ? existing : result

      const merged: any = { ...other, ...base }

      // Union the fields that only some backends populate, preferring whichever
      // copy actually has them rather than whichever copy won on content length.
      const rels = (base.relationships?.length ? base.relationships : other.relationships) ?? []
      if (rels.length) merged.relationships = rels

      // entityRefs drive downstream entity-context linking (search()'s linkedEntityIds
      // annotation and expandWithEntityContext). Union them the same way as relationships,
      // or whichever copy loses on content length silently drops its refs.
      const entityRefs = Array.from(new Set([
        ...(base.metadata?.entityRefs ?? []),
        ...(other.metadata?.entityRefs ?? []),
      ]))
      if (entityRefs.length) {
        merged.metadata = { ...other.metadata, ...base.metadata, entityRefs }
      }

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
   *
   * Two rank-time passes run on top of that composite:
   *
   *  1. TERM WEIGHTING (IDF over the candidate set). Query terms are no longer equal.
   *     A term present in nearly every candidate cannot discriminate between them; a
   *     term present in one or two is what the user actually asked about. See
   *     `computeTermWeights`.
   *  2. NEAR-DUPLICATE SUPPRESSION. A cluster of paraphrases of one entry can no
   *     longer occupy the whole top-N. See `suppressNearDuplicates`.
   */
  private rankResults(results: any[], query: string): any[] {
    // IDF is computed over the candidates actually in hand — no global corpus index
    // is needed, and none exists. Discriminating power is a property of the set being
    // ranked, which is exactly the set we have.
    const termWeights = this.computeTermWeights(results, query)

    const scored = results.map(r => {
      const relevance = this.calculateRelevance(r.content, query, termWeights)
      const recency = this.calculateRecency(r.timestamp)
      // Relevance dominates; recency breaks ties between comparably relevant hits
      // (memory is corrected over time, so newer entries about the same topic usually
      // supersede older ones). Confidence contributes only marginally — it is nearly
      // always 1 and carries almost no ranking signal.
      const score = relevance * 0.70 + recency * 0.25 + (r.confidence ?? 0) * 0.05
      return {
        ...r,
        _score: Number(score.toFixed(4)),
        _relevance: Number(relevance.toFixed(4)),
        _recency: Number(recency.toFixed(4)),
        // New signals, exposed the same inspectable way as _score/_relevance/_recency:
        // a caller can see which query terms this entry actually hit and how much each
        // was worth against this candidate set.
        _termWeights: termWeights,
        _matchedTerms: this.matchedTerms(r.content, query)
      }
    })

    scored.sort((a, b) => b._score - a._score)
    return this.suppressNearDuplicates(scored)
  }

  /**
   * IDF-style weight per query term, computed over the candidate set being ranked.
   *
   * WHY: query "Joytopia brand colors" scored 0.0 on the retrieval baseline. Every
   * candidate was some project's brand colors — Tengo's, BlockCopy26's — because
   * "brand" and "colors" matched everywhere and the one term that actually named the
   * target, "Joytopia", counted for exactly as much as they did (1/3 of coverage
   * each). Unweighted coverage cannot tell a discriminating proper noun apart from
   * boilerplate vocabulary.
   *
   * The weight is the BM25 IDF form, `ln(1 + (N - df + 0.5) / (df + 0.5))`, which is
   * smooth, needs no global corpus, and stays finite at df = N. For the failing query
   * with 6 candidates of which 1 contains "joytopia" and all 6 contain "brand", that
   * is ~1.54 vs ~0.07 — a 20x spread — so the single candidate carrying the proper
   * noun takes nearly all of the available coverage.
   *
   * Weights are normalised to sum to 1 across the terms that appear at all, so
   * `_relevance` keeps the same [0, 1] meaning it had before and stays comparable to
   * the unweighted case.
   *
   * Terms with df = 0 (present in no candidate) get weight 0 and drop out of the
   * denominator: a term nobody has cannot discriminate either, and leaving it in
   * would deflate every score by the same factor for no ranking benefit.
   *
   * Returns {} — meaning "fall back to uniform weights" — when there is nothing to
   * discriminate (fewer than 2 candidates, or no term present anywhere).
   */
  private computeTermWeights(results: any[], query: string): Record<string, number> {
    const terms = this.extractQueryTerms(query)
    if (terms.length === 0) return {}

    const N = results.length
    // With 0 or 1 candidate there is no "rest of the set" to be rare relative to.
    if (N < 2) return {}

    const contents = results.map(r => String(r?.content ?? '').toLowerCase())

    const raw: Record<string, number> = {}
    let total = 0
    for (const term of terms) {
      let df = 0
      for (const content of contents) {
        if (this.countOccurrences(content, term) > 0) df++
      }
      const idf = df === 0 ? 0 : Math.log(1 + (N - df + 0.5) / (df + 0.5))
      raw[term] = idf
      total += idf
    }

    if (total <= 0) return {}

    const weights: Record<string, number> = {}
    for (const term of terms) {
      weights[term] = Number((raw[term] / total).toFixed(6))
    }
    return weights
  }

  /**
   * Query terms after tokenisation and stopword removal — the unit both relevance
   * scoring and term weighting operate on. Extracted so the two can never drift:
   * an IDF weight keyed on a term the matcher never looks up is silently inert.
   */
  private extractQueryTerms(query: string): string[] {
    if (!query) return []
    // Drop stopwords and 1-char fragments so common filler does not inflate coverage.
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'is', 'it'])
    return Array.from(new Set(
      query.trim().toLowerCase().split(/[^a-z0-9_.-]+/).filter(t => t.length > 1 && !STOP.has(t))
    ))
  }

  /**
   * Word-boundary occurrence count of one term in already-lowercased content.
   *
   * Bounded on BOTH sides. A leading \b alone still prefix-matches, so "timeout"
   * would score against "timeoutvalue" — the substring defect this matcher exists to
   * remove, in its prefix form.
   *
   * A short inflectional suffix is allowed so "timeout" matches "timeouts" and
   * "abort" matches "aborted"; that is real recall, not accidental overlap. Terms
   * ending in "e" get that "e" made optional so "route" also reaches "routing"
   * (rout + ing). Anything beyond these suffixes must clear its own word boundary.
   */
  private countOccurrences(contentLower: string, term: string): number {
    if (!contentLower || !term) return 0
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const stem = escaped.endsWith('e') ? `${escaped.slice(0, -1)}e?` : escaped
    return (contentLower.match(new RegExp(`\\b${stem}(?:s|es|ed|ing)?\\b`, 'g')) || []).length
  }

  /** Which query terms this entry actually contains — the per-result half of `_termWeights`. */
  private matchedTerms(content: string, query: string): string[] {
    if (!content) return []
    const contentLower = String(content).toLowerCase()
    return this.extractQueryTerms(query).filter(t => this.countOccurrences(contentLower, t) > 0)
  }

  /**
   * Demote near-duplicates so one cluster of paraphrases cannot own the top-N.
   *
   * WHY: query "LRI binary parsing format" scored 0.0 on the retrieval baseline. The
   * top five hits were all near-paraphrases of the SAME governance/process rule —
   * the corpus holds 3+ close variants of it — and the single entry that actually
   * described the binary format sat at ~8th. Every one of those five was individually
   * a defensible hit; collectively they were one hit repeated, and they consumed the
   * entire result window.
   *
   * Note this is a different problem from `deduplicateResults`, which collapses the
   * same entry id arriving from several backends. These are genuinely distinct rows
   * with distinct ids whose *content* is a rewording of each other.
   *
   * Measure: Jaccard over content-word token sets, vetoed by literal conflict. No
   * embeddings, no model, O(n²) on a result set that is tens of items at most.
   * Deliberately conservative — a missed duplicate costs one wasted slot, a wrongly
   * collapsed pair costs a real answer:
   *
   *  - Threshold 0.50 of the combined vocabulary, sitting in the middle of a measured
   *    gap. Against real corpus shapes, reworded variants of one rule land at
   *    0.70-0.89, while distinct entries that merely share vocabulary top out at 0.27
   *    (two different Ollama facts 0.04, two brand-colors entries 0.11, the
   *    contradicting Phoenix camera-count entries 0.15, two steps of one procedure
   *    0.19, two facts about kms_supersede 0.20, two distinct prose rules on one topic
   *    0.27).
   *  - LITERAL CONFLICT VETO. Two shapes defeat word overlap on its own: templated
   *    one-liners ("service X listens on port N at host H" — 0.38 between entries about
   *    entirely different services) and enumerated tables ("the refuse band starts at
   *    0.88 / the confirm band runs 0.78 to 0.88" — 0.41, and they are not the same
   *    fact). Both would otherwise sit uncomfortably close to the threshold, and both
   *    are common in this corpus. What separates them from real paraphrases is that a
   *    rewording preserves
   *    the VALUES while a different fact changes them. So when both entries carry
   *    literals — tokens holding a digit or an internal dot: numbers, versions, ports,
   *    hostnames, filenames, hex offsets — and the smaller literal set is less than 60%
   *    contained in the larger, the pair is never a duplicate no matter how much prose
   *    it shares. Containment rather than Jaccard, so a paraphrase that simply drops a
   *    detail is not vetoed. If either side has no literals the veto cannot fire.
   *  - Entries with fewer than 8 content tokens are neither demoted nor allowed to
   *    demote others. Jaccard is unstable on very short text — "Rich prefers dark
   *    mode" vs "Rich prefers light mode" scores 0.75 while meaning opposite things —
   *    so short entries are exempt in both directions.
   *  - Single-linkage clustering: a candidate is compared against every member of a
   *    cluster, not just its representative. Paraphrase chains drift, and variant 4 of
   *    a rule is often closer to variant 2 than to the one that happened to rank first.
   *  - Results are DEMOTED, never dropped. The cluster's best-scoring member keeps its
   *    full score; the second gets 0.45x, the third 0.2x, and so on. A caller who
   *    wants the variants can still page down to them, and `_duplicateOf` /
   *    `_duplicateSimilarity` / `_duplicatePenalty` say exactly what happened.
   *
   * Input must already be sorted best-first: the first member of a cluster reached is
   * the one kept at full score.
   */
  private suppressNearDuplicates(sorted: any[]): any[] {
    const DUP_SIMILARITY = 0.50   // shared fraction of combined vocabulary
    const MIN_TOKENS = 8          // below this, Jaccard is noise
    const DEMOTE = 0.45           // multiplicative, compounding per extra cluster member

    const clusters: Array<{ key: string, members: Array<{ tokens: Set<string>, literals: Set<string> }> }> = []

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i]
      r._duplicateOf = null
      r._duplicateSimilarity = 0
      r._duplicatePenalty = 1

      const tokens = this.contentTokens(r.content)
      if (tokens.size < MIN_TOKENS) continue
      const literals = this.literalTokens(tokens)

      let best: { key: string, members: Array<{ tokens: Set<string>, literals: Set<string> }> } | null = null
      let bestSim = 0
      for (const cluster of clusters) {
        for (const member of cluster.members) {
          if (this.literalsConflict(literals, member.literals)) continue
          const sim = this.jaccard(tokens, member.tokens)
          if (sim > bestSim) {
            bestSim = sim
            best = cluster
          }
        }
      }

      if (best && bestSim >= DUP_SIMILARITY) {
        const penalty = Math.pow(DEMOTE, best.members.length)
        best.members.push({ tokens, literals })
        r._duplicateOf = best.key
        r._duplicateSimilarity = Number(bestSim.toFixed(4))
        r._duplicatePenalty = Number(penalty.toFixed(4))
        r._score = Number((r._score * penalty).toFixed(4))
      } else {
        clusters.push({ key: r.id ?? `#${i}`, members: [{ tokens, literals }] })
      }
    }

    // Stable re-sort: demoted members fall below the distinct entries they were
    // crowding out, while untouched results keep their relative order.
    return sorted.sort((a, b) => b._score - a._score)
  }

  /**
   * Content-word token set for near-duplicate comparison.
   *
   * A wider stopword list than query-term extraction uses on purpose: function words
   * are shared by *every* pair of English sentences, so leaving them in inflates
   * Jaccard uniformly and pushes unrelated entries toward the threshold. Duplicate
   * detection wants to compare what the entries are ABOUT.
   */
  private contentTokens(content: string): Set<string> {
    if (!content) return new Set()
    const STOP = new Set([
      'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'is', 'it', 'be',
      'are', 'was', 'were', 'been', 'as', 'at', 'by', 'with', 'from', 'that', 'this',
      'these', 'those', 'but', 'not', 'no', 'do', 'does', 'did', 'has', 'have', 'had',
      'will', 'would', 'can', 'could', 'should', 'must', 'may', 'if', 'then', 'than',
      'so', 'such', 'all', 'any', 'each', 'its', 'we', 'you', 'they', 'them', 'their',
      'our', 'us', 'via', 'per', 'into', 'onto', 'out', 'up', 'over', 'under', 'when',
      'while', 'until', 'unless', 'also', 'only', 'just', 'more', 'most', 'other',
      'there', 'here', 'how', 'what', 'which', 'who', 'why'
    ])
    const tokens = String(content).toLowerCase().split(/[^a-z0-9_.-]+/)
    const out = new Set<string>()
    for (const raw of tokens) {
      // Trailing sentence punctuation rides along because "." and "-" are kept inside
      // tokens (they have to be, for "0.88", "kms.yaker.org" and "read-only"). Trim it
      // at the edges only, so "default." and "default" are the same word — and so the
      // literal test below is not fooled into treating every sentence-final word as a
      // dotted identifier.
      const t = raw.replace(/^[.-]+/, '').replace(/[.-]+$/, '')
      if (t.length <= 1 || STOP.has(t)) continue
      // Fold trivial inflections so "modified"/"modify" style rewordings of one rule
      // are not treated as different vocabulary.
      out.add(t.replace(/(?:ing|ed|es|s)$/, ''))
    }
    return out
  }

  /**
   * The subset of tokens that carry a VALUE rather than prose: anything with a digit
   * (8180, 0.88, 32-byte, 0x10, v2) or an internal dot (kms.yaker.org, sparrowdb.node,
   * metadata.subject). These are what a reworded entry preserves and a different fact
   * changes — see the literal-conflict veto in `suppressNearDuplicates`.
   */
  private literalTokens(tokens: Set<string>): Set<string> {
    const out = new Set<string>()
    for (const t of tokens) {
      if (/\d/.test(t) || t.includes('.')) out.add(t)
    }
    return out
  }

  /**
   * True when two entries cite materially different values, which rules out their
   * being rewordings of each other.
   *
   * Containment of the smaller set in the larger, not Jaccard: a paraphrase is allowed
   * to drop details ({0.88} inside {0.88, 0.85} is not a conflict), but it may not
   * substitute them ({8180} vs {9102} is). If either side cites no literals at all
   * there is nothing to compare and the veto stays silent.
   */
  private literalsConflict(a: Set<string>, b: Set<string>): boolean {
    if (a.size === 0 || b.size === 0) return false
    const MIN_CONTAINMENT = 0.6
    const [small, large] = a.size <= b.size ? [a, b] : [b, a]
    let shared = 0
    for (const t of small) if (large.has(t)) shared++
    return (shared / small.size) < MIN_CONTAINMENT
  }

  /** |A ∩ B| / |A ∪ B|. Empty on either side means "no evidence of duplication". */
  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0
    let intersection = 0
    const [small, large] = a.size <= b.size ? [a, b] : [b, a]
    for (const t of small) if (large.has(t)) intersection++
    const union = a.size + b.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  /**
   * Lexical relevance of content to the query, in [0, 1].
   *
   * Word-boundary matched rather than substring matched: the old `includes(term)`
   * scored an insurance doc about a *session* timeout as relevant to a query about
   * an *Ollama* timeout, because "timeout" appeared somewhere in the text. Coverage
   * (what fraction of query terms appear at all) is the dominant signal, with bounded
   * bonuses for repetition and for the full query appearing as a phrase.
   *
   * `termWeights` (optional) makes coverage WEIGHTED rather than uniform, so a rare,
   * discriminating term counts for more of the score than boilerplate vocabulary the
   * whole candidate set shares. See `computeTermWeights` for how they are derived and
   * why. Omitted or empty → every term weighs 1, i.e. the original behaviour exactly;
   * the function stays usable standalone on a single document with no candidate set.
   */
  private calculateRelevance(content: string, query: string, termWeights?: Record<string, number>): number {
    if (!content || !query) return 0

    const contentLower = content.toLowerCase()
    const queryLower = query.trim().toLowerCase()
    const terms = this.extractQueryTerms(query)
    if (terms.length === 0) return 0

    const weightFor = (term: string): number => {
      if (termWeights && Object.prototype.hasOwnProperty.call(termWeights, term)) {
        const w = termWeights[term]
        // A legitimate 0 (term present in no candidate) must survive; only garbage
        // falls back to the neutral weight.
        if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return w
      }
      return 1
    }

    let totalWeight = 0
    let matchedWeight = 0
    let densityWeight = 0
    for (const term of terms) {
      const weight = weightFor(term)
      totalWeight += weight
      const occurrences = this.countOccurrences(contentLower, term)
      if (occurrences > 0) {
        matchedWeight += weight
        // Diminishing returns — a term repeated 20x is not 20x more relevant.
        densityWeight += weight * (Math.min(occurrences, 5) / 5)
      }
    }

    // Every term weighed 0 → nothing in this query can discriminate. Score 0 rather
    // than divide by zero.
    if (totalWeight <= 0) return 0

    const coverage = matchedWeight / totalWeight      // how much of the query is present
    const densityScore = densityWeight / totalWeight  // how emphatically

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
