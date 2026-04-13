/**
 * Unified Store Tool - The heart of intelligent storage routing
 */

import crypto from 'crypto'
import { UnifiedKnowledge, StorageDecision, SystemName, KnowledgeFlag } from '../types/index.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import { OllamaStorageRouter } from '../routing/OllamaStorageRouter.js'
import { EnrichmentQueue } from '../inference/EnrichmentQueue.js'
import { FACTCache } from '../cache/FACTCache.js'
import { MongoDBStorage, Neo4jStorage, Mem0Storage } from '../storage/index.js'
import type { GraphStorage } from '../types/index.js'
import { ContentInference } from '../inference/ContentInference.js'

const debug = (...args: unknown[]) => { if (process.env.KMS_DEBUG) console.error(...args) }

export class UnifiedStoreTool {
  private router: IntelligentStorageRouter
  private storage: {
    mongodb: MongoDBStorage
    neo4j: GraphStorage
    mem0: Mem0Storage
  }
  private cache: FACTCache
  private ollamaRouter: OllamaStorageRouter | null
  private enrichmentQueue: EnrichmentQueue | null

  constructor(
    router: IntelligentStorageRouter,
    storage: { mongodb: MongoDBStorage, neo4j: GraphStorage, mem0: Mem0Storage },
    cache: FACTCache | null,
    ollamaRouter?: OllamaStorageRouter | null,
    enrichmentQueue?: EnrichmentQueue | null
  ) {
    this.router = router
    this.storage = storage
    this.cache = cache as FACTCache // Now using real cache
    this.ollamaRouter = ollamaRouter ?? null
    this.enrichmentQueue = enrichmentQueue ?? null
  }

  /**
   * Store knowledge with intelligent routing
   * This is the main "unified_store" tool function
   */
  async store(args: {
    content: string
    contentType?: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'
    source?: 'personal' | 'technical' | 'cross_domain'
    userId?: string
    metadata?: Record<string, any>
    confidence?: number
    relationships?: Array<{
      targetId: string
      type: string
      strength: number
    }>
  }): Promise<{
    success: boolean
    id: string
    storageDecision: StorageDecision
    cached: boolean
    performance: {
      routingTime: number
      storageTime: number
      totalTime: number
    }
  }> {
    const startTime = Date.now()

    debug(`\n🚀 UNIFIED STORE Starting...`)
    debug(`📝 Content: "${args.content.slice(0, 100)}${args.content.length > 100 ? '...' : ''}"`)

    // Apply smart inference if needed
    let enrichedArgs = { ...args }
    const inference = ContentInference.analyze(args.content)

    // Use inference to fill in missing parameters
    if (!args.contentType) {
      enrichedArgs.contentType = inference.contentType
      debug(`🧠 Inferred content type: ${inference.contentType} (confidence: ${inference.confidence})`)
    }

    if (!args.source) {
      // Infer source based on content and project
      if (inference.detectedProject) {
        enrichedArgs.source = 'technical'
      } else if (inference.contentType === 'memory' || inference.contentType === 'insight') {
        enrichedArgs.source = 'personal'
      } else {
        enrichedArgs.source = 'cross_domain'
      }
      debug(`🧠 Inferred source: ${enrichedArgs.source}`)
    }

    // Enhance metadata with inference
    const enhancedMetadata = ContentInference.generateMetadata(args.content, args.metadata)
    enrichedArgs.metadata = enhancedMetadata

    // Use inferred confidence if not provided
    if (!args.confidence) {
      enrichedArgs.confidence = inference.confidence
    }

    // Suggest relationships if none provided
    if (!args.relationships || args.relationships.length === 0) {
      const suggestedRelationships = ContentInference.suggestRelationships(args.content)
      if (suggestedRelationships.length > 0) {
        debug(`💡 Suggested relationships: ${suggestedRelationships.map(r => r.type).join(', ')}`)
      }
    }

    debug(`🏷️  Type: ${enrichedArgs.contentType}, Source: ${enrichedArgs.source}`)
    debug(`👤 User: ${enrichedArgs.userId || 'auto'}, Context: ${inference.detectedProject || 'general'}`)
    debug(`🏷️  Tags: ${enhancedMetadata.tags?.join(', ') || 'none'}`)

    const defaultUserId = process.env.KMS_DEFAULT_USER_ID || 'personal'
    const resolvedUserId = enrichedArgs.userId || defaultUserId

    // Create unified knowledge object
    const knowledge: UnifiedKnowledge = {
      id: crypto.randomUUID(),
      content: args.content,
      contentType: enrichedArgs.contentType!,
      source: enrichedArgs.source!,
      userId: resolvedUserId,
      metadata: enrichedArgs.metadata || {},
      timestamp: new Date(),
      confidence: enrichedArgs.confidence || 0.8,
      relationships: enrichedArgs.relationships || []
    }

    // Step 1: Get intelligent storage decision
    const routingStartTime = Date.now()

    let primarySystem: SystemName
    let secondarySystems: SystemName[]
    let decision: StorageDecision

    if (this.ollamaRouter) {
      // Pass all resolved knowledge fields so the fallback router has full context
      const routingMetadata = {
        ...knowledge.metadata,
        contentType: knowledge.contentType,
        source: knowledge.source,
        userId: knowledge.userId,
      }
      const ollamaDecision = await this.ollamaRouter.getStorageTargets(
        knowledge.content,
        routingMetadata
      )
      primarySystem = ollamaDecision.targets[0] as SystemName
      secondarySystems = ollamaDecision.targets.slice(1) as SystemName[]
      // Derive cacheStrategy from the fallback router so it stays policy-consistent
      const fallbackDecision = this.router.determineStorage(knowledge)
      decision = {
        primary: primarySystem,
        secondary: secondarySystems,
        cacheStrategy: fallbackDecision.cacheStrategy,
        reasoning: `OllamaStorageRouter(${ollamaDecision.source}, confidence=${ollamaDecision.confidence.toFixed(2)})`
      }
    } else {
      decision = this.router.determineStorage(knowledge)
      primarySystem = decision.primary
      secondarySystems = decision.secondary ?? []
    }

    const routingTime = Date.now() - routingStartTime

    debug(`\n🧠 STORAGE DECISION:`)
    debug(`   Primary: ${decision.primary}`)
    debug(`   Secondary: ${decision.secondary?.join(', ') || 'none'}`)
    debug(`   Cache Strategy: ${decision.cacheStrategy}`)
    debug(`   Reasoning: ${decision.reasoning}`)

    // Step 2: Store in systems
    const storageStartTime = Date.now()

    try {
      // Store in primary system
      await this.storeInSystem(knowledge, primarySystem)

      // Store in secondary systems (for cross-linking)
      if (secondarySystems.length > 0) {
        debug(`\n🔗 Cross-linking to secondary systems...`)
        await Promise.all(
          secondarySystems.map(async (system) => {
            try {
              await this.storeInSystem(knowledge, system)
              debug(`✅ Cross-stored in ${system}`)
            } catch (error) {
              console.warn(`⚠️ Failed to cross-store in ${system}:`, error instanceof Error ? error.message : String(error))
            }
          })
        )
      }

      // Queue enrichment once for the primary system (same content — no need to repeat per secondary)
      if (this.enrichmentQueue) {
        this.enrichmentQueue.add(knowledge.id, knowledge.content, primarySystem as 'mongodb' | 'mem0' | 'neo4j')
      }
      
      const storageTime = Date.now() - storageStartTime

      // Step 3: Cache based on strategy
      let cached = false
      if (decision.cacheStrategy !== 'skip') {
        const cacheKey = FACTCache.generateKnowledgeKey(
          knowledge.userId,
          knowledge.contentType,
          { id: knowledge.id }
        )
        
        if (this.cache) {
          const ttl = this.getCacheTTL(decision.cacheStrategy)
          await this.cache.set(cacheKey, knowledge, ttl)
          cached = true
          
          debug(`💾 Cached with ${decision.cacheStrategy} strategy (TTL: ${Math.round(ttl/1000)}s)`)
        }
      }

      const totalTime = Date.now() - startTime

      debug(`\n✅ UNIFIED STORE COMPLETE`)
      debug(`   ID: ${knowledge.id}`)
      debug(`   Total Time: ${totalTime}ms`)
      debug(`   Systems: ${[decision.primary, ...(decision.secondary || [])].join(', ')}`)

      return {
        success: true,
        id: knowledge.id,
        storageDecision: decision,
        cached,
        performance: {
          routingTime,
          storageTime,
          totalTime
        }
      }

    } catch (error) {
      console.error(`❌ UNIFIED STORE FAILED:`, error)
      
      return {
        success: false,
        id: knowledge.id,
        storageDecision: decision,
        cached: false,
        performance: {
          routingTime,
          storageTime: Date.now() - storageStartTime,
          totalTime: Date.now() - startTime
        }
      }
    }
  }

  /**
   * Store knowledge in a specific system
   */
  private async storeInSystem(knowledge: UnifiedKnowledge, system: SystemName): Promise<void> {
    debug(`📊 Storing in ${system}...`)
    
    switch (system) {
      case 'mem0':
        await this.storage.mem0.store(knowledge)
        break
      case 'neo4j':
        await this.storage.neo4j.store(knowledge)
        break
      case 'mongodb':
        await this.storage.mongodb.store(knowledge)
        break
      default:
        throw new Error(`Unknown storage system: ${system}`)
    }
    
    debug(`✅ Successfully stored in ${system}`)
  }

  /**
   * Get cache TTL based on strategy
   */
  private getCacheTTL(strategy: 'L1' | 'L2' | 'L3' | 'skip'): number {
    switch (strategy) {
      case 'L1': return 300000   // 5 minutes - aggressive caching
      case 'L2': return 1800000  // 30 minutes - moderate caching
      case 'L3': return 3600000  // 1 hour - conservative caching
      default: return 1800000    // Default to L2
    }
  }

  /**
   * Get storage recommendation without storing
   * This supports the "get_storage_recommendation" tool
   */
  getStorageRecommendation(args: {
    content: string
    contentType?: string
    metadata?: Record<string, any>
  }): StorageDecision {
    debug(`\n🤔 STORAGE RECOMMENDATION REQUEST`)
    debug(`📝 Content: "${args.content.slice(0, 100)}..."`)
    debug(`🏷️  Type: ${args.contentType || 'auto-detect'}`)

    const decision = this.router.determineStorage({
      content: args.content,
      contentType: args.contentType as any,
      metadata: args.metadata
    })

    debug(`\n💡 RECOMMENDATION:`)
    debug(`   Primary: ${decision.primary}`)
    debug(`   Secondary: ${decision.secondary?.join(', ') || 'none'}`)
    debug(`   Cache: ${decision.cacheStrategy}`)
    debug(`   Why: ${decision.reasoning}`)

    return decision
  }

  /**
   * Test the routing logic with sample data
   */
  async testRouting(): Promise<{
    tests: Array<{
      content: string
      contentType: string
      decision: StorageDecision
    }>
  }> {
    debug(`\n🧪 TESTING ROUTING LOGIC`)

    const testCases = [
      {
        content: "Client prefers morning coaching sessions and responds well to visualization techniques",
        contentType: "memory"
      },
      {
        content: "Reframing technique shows 85% effectiveness for anxiety-related issues across 50 clients",
        contentType: "insight"
      },
      {
        content: "Session configuration: duration 60min, frequency weekly, payment auto-renew enabled",
        contentType: "fact"
      },
      {
        content: "Discovered pattern: clients with morning routine consistency achieve goals 40% faster",
        contentType: "pattern"
      },
      {
        content: "Fixed bug in authentication middleware causing 500 errors on password reset",
        contentType: "procedure"
      }
    ]

    const results = testCases.map(test => {
      const decision = this.router.determineStorage({
        content: test.content,
        contentType: test.contentType as any
      })

      debug(`\n📝 "${test.content.slice(0, 50)}..."`)
      debug(`   Type: ${test.contentType} → ${decision.primary}`)
      debug(`   Reasoning: ${decision.reasoning}`)

      return {
        content: test.content,
        contentType: test.contentType,
        decision
      }
    })

    return { tests: results }
  }

  /**
   * Get routing statistics
   */
  getRoutingStats(): Record<string, any> {
    return this.router.getRoutingStats()
  }

  // ===========================================================================
  // Corrective operations (kms_update / kms_delete / kms_supersede / kms_flag /
  // kms_reap). These mutate or hide existing entries — the additive complement
  // to `store`.
  //
  // Soft-delete model: kms_delete and kms_supersede flag entries rather than
  // physically removing them. The reaper sweeps flagged entries older than 90
  // days. The read path (unified_search and downstream context-injection) hides
  // flagged entries by default; pass options.includeFlagged=true to see them.
  // ===========================================================================

  /**
   * Update an existing entry by ID. Mutates content/metadata in place; bumps
   * timestamp. NOT a flag operation — for "I was wrong" use supersede instead.
   * Use update for genuine edits (typo fix, metadata correction, confidence
   * adjustment).
   *
   * Calls SparrowDB and MongoDB. Mem0 is skipped — its memories are LLM-managed
   * and re-extracted on next store, so direct edits don't make sense.
   */
  async update(args: {
    id: string
    content?: string
    metadata?: Record<string, any>
    confidence?: number
    reason?: string
  }): Promise<{ success: boolean; id: string; backends: string[]; reason?: string }> {
    const updates: Partial<UnifiedKnowledge> = {}
    if (args.content !== undefined) updates.content = args.content
    if (args.metadata !== undefined) updates.metadata = args.metadata
    if (args.confidence !== undefined) updates.confidence = args.confidence

    // Append the reason to metadata.update_history for audit trail.
    if (args.reason) {
      const history = (updates.metadata?.update_history as any[]) || []
      history.push({ at: new Date().toISOString(), reason: args.reason })
      updates.metadata = { ...(updates.metadata || {}), update_history: history }
    }

    const backends: string[] = []

    if (typeof (this.storage.neo4j as any).update === 'function') {
      try {
        const ok = await (this.storage.neo4j as any).update(args.id, updates)
        if (ok) backends.push('sparrowdb')
      } catch (e) {
        console.warn('⚠️  unified_update SparrowDB error:', e)
      }
    }

    try {
      const ok = await this.storage.mongodb.update(args.id, updates)
      if (ok) backends.push('mongodb')
    } catch (e) {
      console.warn('⚠️  unified_update MongoDB error:', e)
    }

    return {
      success: backends.length > 0,
      id: args.id,
      backends,
      reason: args.reason
    }
  }

  /**
   * Soft-delete: flag the entry as DELETED. Reversible until the reaper runs
   * (90 days by default). Hidden from search by default.
   *
   * Use kms_supersede if there's a corrected replacement; use kms_delete only
   * for noise (test entries, accidental stores, garbage).
   */
  async delete(args: {
    id: string
    reason?: string
    by?: string
  }): Promise<{ success: boolean; id: string; backends: string[]; flag: KnowledgeFlag | null; reason?: string }> {
    return this.flag({
      id: args.id,
      flag: 'DELETED',
      note: args.reason,
      by: args.by
    })
  }

  /**
   * Mark an entry with an arbitrary flag without modifying its content.
   * Pass `flag=null` to clear (un-retract).
   *
   * Used by kms_delete (DELETED), kms_supersede (SUPERSEDED), and direct
   * flagging for RETRACTED/UNVERIFIED.
   */
  async flag(args: {
    id: string
    flag: KnowledgeFlag | null
    note?: string
    by?: string
    superseded_by?: string
  }): Promise<{ success: boolean; id: string; backends: string[]; flag: KnowledgeFlag | null; reason?: string }> {
    const backends: string[] = []

    if (typeof (this.storage.neo4j as any).flag === 'function') {
      try {
        const ok = await (this.storage.neo4j as any).flag(
          args.id, args.flag, args.note, args.by, args.superseded_by
        )
        if (ok) backends.push('sparrowdb')
      } catch (e) {
        console.warn('⚠️  unified_flag SparrowDB error:', e)
      }
    }

    try {
      const ok = await this.storage.mongodb.flag(
        args.id, args.flag, args.note, args.by, args.superseded_by
      )
      if (ok) backends.push('mongodb')
    } catch (e) {
      console.warn('⚠️  unified_flag MongoDB error:', e)
    }

    // Mem0: best-effort delete on flag != null. Mem0 has no flag concept and
    // its memories get re-extracted on next store; deleting prevents stale
    // copies from leaking back through Mem0 search.
    if (args.flag !== null) {
      try {
        await this.storage.mem0.deleteMemory(args.id)
      } catch (e) {
        // Mem0 IDs don't always match unified IDs; non-fatal.
        debug(`Mem0 delete on flag failed (non-fatal): ${e}`)
      }
    }

    // Invalidate cache so the next read sees the flag.
    // Search cache keys are hashed (kms:search:<hash>) and don't contain entry
    // IDs, so we have to invalidate the whole search namespace. Knowledge cache
    // entries that mention this ID also get cleared.
    if (this.cache) {
      try {
        await this.cache.invalidate('kms:search:*')
        await this.cache.invalidate(`*${args.id}*`)
      } catch { /* non-fatal */ }
    }

    return {
      success: backends.length > 0,
      id: args.id,
      backends,
      flag: args.flag,
      reason: args.note
    }
  }

  /**
   * Atomic supersede: store a new entry, then flag the old one as SUPERSEDED
   * with a back-link to the new entry. The new entry's metadata gets a forward
   * link (`supersedes`) for bidirectional chain tracing.
   *
   * If the flag step fails, rolls back by hard-deleting the new entry to keep
   * the operation atomic. Returns the new entry's ID on success.
   */
  async supersede(args: {
    old_id: string
    new_content: string
    contentType?: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'
    source?: 'personal' | 'technical' | 'cross_domain'
    userId?: string
    metadata?: Record<string, any>
    confidence?: number
    reason?: string
  }): Promise<{
    success: boolean
    old_id: string
    new_id?: string
    backends?: string[]
    reason?: string
    error?: string
  }> {
    // Step 1: store the new entry (with forward-link to the old one)
    const storeResult = await this.store({
      content: args.new_content,
      contentType: args.contentType,
      source: args.source,
      userId: args.userId,
      confidence: args.confidence,
      metadata: {
        ...(args.metadata || {}),
        supersedes: args.old_id,
        supersede_reason: args.reason
      }
    })

    if (!storeResult.success) {
      return {
        success: false,
        old_id: args.old_id,
        error: 'Failed to store new entry'
      }
    }

    const new_id = storeResult.id

    // Step 2: flag the old entry as SUPERSEDED with back-link to the new one
    const flagResult = await this.flag({
      id: args.old_id,
      flag: 'SUPERSEDED',
      note: args.reason || `Superseded by ${new_id}`,
      superseded_by: new_id
    })

    if (!flagResult.success) {
      // Rollback: hard-delete the new entry so we don't leave a dangling replacement.
      // NOTE: flag() returns false for ANY backend failure, not just "not found".
      // The error message below reflects this so agents can distinguish a
      // truly missing ID from a transient backend failure and retry if needed.
      console.warn(`⚠️  unified_supersede rollback: flag failed, deleting new entry ${new_id}`)
      try {
        if (typeof (this.storage.neo4j as any).delete === 'function') {
          await (this.storage.neo4j as any).delete(new_id)
        }
        await this.storage.mongodb.delete(new_id)
        await this.storage.mem0.deleteMemory(new_id).catch(() => {})
      } catch (e) {
        console.error('❌ unified_supersede rollback failed:', e)
      }
      return {
        success: false,
        old_id: args.old_id,
        error: `Flag step failed for ${args.old_id} (entry not found, or backend write error). New entry ${new_id} was rolled back — retry may succeed if this was transient.`
      }
    }

    return {
      success: true,
      old_id: args.old_id,
      new_id,
      backends: flagResult.backends,
      reason: args.reason
    }
  }

  /**
   * Reaper — find or hard-delete flagged entries older than `olderThanDays`.
   * Defaults to 90 days, dry-run by default.
   *
   * dryRun=true (default): returns the list of candidates without deleting.
   * dryRun=false: hard-deletes each candidate from all backends.
   */
  async reap(args: {
    olderThanDays?: number
    dryRun?: boolean
  }): Promise<{
    success: boolean
    olderThanDays: number
    dryRun: boolean
    candidates: Array<{
      id: string
      flag: string
      flag_date?: string
      flag_note?: string
      backends_found: string[]
    }>
    deleted?: Array<{ id: string; backends: string[] }>
  }> {
    const olderThanDays = args.olderThanDays ?? 90
    const dryRun = args.dryRun !== false  // default true
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)

    // Collect candidates from each backend, deduplicated by ID
    const candidatesById = new Map<string, {
      id: string
      flag: string
      flag_date?: string
      flag_note?: string
      backends_found: string[]
    }>()

    // SparrowDB candidates. `await` defensively — the current SparrowDB
    // implementation is synchronous, but the `neo4j` slot is typed as
    // GraphStorage and could hold an async listFlagged in the future.
    // `await` on a non-Promise resolves to the value, so this is safe for
    // both sync and async implementations.
    if (typeof (this.storage.neo4j as any).listFlagged === 'function') {
      try {
        const flagged = await (this.storage.neo4j as any).listFlagged() as Array<any>
        for (const e of flagged) {
          if (e.flag_date && new Date(e.flag_date) < cutoff) {
            const existing = candidatesById.get(e.id)
            if (existing) {
              existing.backends_found.push('sparrowdb')
            } else {
              candidatesById.set(e.id, {
                id: e.id,
                flag: e.flag,
                flag_date: e.flag_date,
                flag_note: e.flag_note,
                backends_found: ['sparrowdb']
              })
            }
          }
        }
      } catch (e) {
        console.warn('⚠️  reap: SparrowDB listFlagged error:', e)
      }
    }

    // MongoDB candidates
    try {
      const flagged = await this.storage.mongodb.listFlagged(cutoff)
      for (const e of flagged) {
        const existing = candidatesById.get(e.id)
        if (existing) {
          existing.backends_found.push('mongodb')
        } else {
          candidatesById.set(e.id, {
            id: e.id,
            flag: String(e.flag),
            flag_date: e.flag_date instanceof Date ? e.flag_date.toISOString() : (e.flag_date as any),
            flag_note: e.flag_note,
            backends_found: ['mongodb']
          })
        }
      }
    } catch (e) {
      console.warn('⚠️  reap: MongoDB listFlagged error:', e)
    }

    const candidates = Array.from(candidatesById.values())

    if (dryRun) {
      return {
        success: true,
        olderThanDays,
        dryRun: true,
        candidates
      }
    }

    // Apply deletions
    const deleted: Array<{ id: string; backends: string[] }> = []
    for (const c of candidates) {
      const backends: string[] = []
      if (typeof (this.storage.neo4j as any).delete === 'function') {
        try {
          const ok = await (this.storage.neo4j as any).delete(c.id)
          if (ok) backends.push('sparrowdb')
        } catch (e) { /* logged below */ }
      }
      try {
        const ok = await this.storage.mongodb.delete(c.id)
        if (ok) backends.push('mongodb')
      } catch (e) { /* logged below */ }
      try {
        await this.storage.mem0.deleteMemory(c.id)
        backends.push('mem0')
      } catch { /* mem0 IDs may not match — non-fatal */ }
      deleted.push({ id: c.id, backends })
      console.log(`🗑️  reap: hard-deleted ${c.id} (flag=${c.flag}, age>${olderThanDays}d) from [${backends.join(',')}]`)
    }

    return {
      success: true,
      olderThanDays,
      dryRun: false,
      candidates,
      deleted
    }
  }
}
