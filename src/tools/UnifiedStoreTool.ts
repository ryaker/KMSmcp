/**
 * Unified Store Tool - The heart of intelligent storage routing
 */

import crypto from 'crypto'
import { UnifiedKnowledge, StorageDecision, SystemName, KnowledgeFlag } from '../types/index.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import { OllamaStorageRouter } from '../routing/OllamaStorageRouter.js'
import { EnrichmentQueue } from '../inference/EnrichmentQueue.js'
import { FACTCache } from '../cache/FACTCache.js'
import { MongoDBStorage, Mem0Storage } from '../storage/index.js'
import type { GraphStorage } from '../types/index.js'
import { ContentInference } from '../inference/ContentInference.js'
import {
  EmbeddingService,
  PENDING_EMBEDDING_KEY,
  PENDING_EMBEDDER_ID_KEY
} from '../embedding/EmbeddingService.js'
import type { LLMJudgeService, LLMRelation } from '../embedding/LLMJudgeService.js'
import { logger } from '../logger.js' 

const debug = (...args: unknown[]) => { if (process.env.KMS_DEBUG) console.error(...args) }

// -------------------------------------------------------------------------
// Dedup gate (DG-T1-B) — threshold constants and per-contentType overrides
//
// Calibrated empirically against ~1200-entry KMS corpus by DG-INV-2 (PR #60):
//   - 0.88 refuse / 0.78 confirm = balanced precision/recall on real data
//   - Spec's original 0.90/0.75 was too strict (lost 78% of dups) and
//     too loose (17% false-positive on cross-topic distincts).
//
// Per-contentType overrides:
//   - procedure: refuse=0.85 — refutation rewrites cluster lower
//   - pattern:   refuse=0.92 — duplicates extremely tight on this type
// -------------------------------------------------------------------------

const DEDUP_DEFAULT_REFUSE = 0.88
const DEDUP_DEFAULT_CONFIRM = 0.78

const DEDUP_PER_TYPE_REFUSE: Record<string, number> = {
  procedure: 0.85,
  pattern: 0.92
}

function resolveDedupThresholds(
  contentType: string | undefined,
  override?: { refuse?: number; confirm?: number }
): { refuse: number; confirm: number; usedOverride: boolean } {
  // Override path: only honored when BOTH refuse and confirm are provided
  // (asymmetric overrides are rejected to prevent the confirm-band collapsing
  // or inverting). This is the documented escape-hatch contract.
  if (override) {
    const hasBoth = typeof override.refuse === 'number' && typeof override.confirm === 'number'
    if (hasBoth) {
      const r = override.refuse as number
      const c = override.confirm as number
      // Sanity: refuse must be ≥ confirm. If a caller passes them inverted,
      // ignore the override and fall through to defaults.
      if (r >= c) {
        return { refuse: r, confirm: c, usedOverride: true }
      }
    }
  }

  const refuse = (contentType && DEDUP_PER_TYPE_REFUSE[contentType] !== undefined)
    ? DEDUP_PER_TYPE_REFUSE[contentType]
    : DEDUP_DEFAULT_REFUSE
  return { refuse, confirm: DEDUP_DEFAULT_CONFIRM, usedOverride: false }
}

export interface DedupCandidate {
  id: string
  similarity: number
  content_preview: string
  contentType: string
  source: string
  subject?: string
  created: string
  flag?: string | null
  /**
   * Populated by Tier 2 LLM judge (DG-T2-A, issue #49). One of:
   *   - 'duplicate' | 'supersedes' | 'supersedes-reverse'
   *   - 'complement' | 'contradicts' | 'unrelated'
   *
   * Null when:
   *   - judge unavailable (no API key configured)
   *   - candidate is in the refuse band (was set to 'duplicate' inline; see
   *     UnifiedStoreTool.store)
   *   - the individual classify() call failed/timed out (other candidates'
   *     classifications still ship)
   */
  llm_relation: LLMRelation | null
}

export interface DedupRequiredResponse {
  status: 'dedup_required'
  candidates: DedupCandidate[]
  message: string
  retry_with: string[]
  /** Threshold band for the highest-similarity candidate ('refuse' | 'confirm'). */
  band: 'refuse' | 'confirm'
  /** Echo of the thresholds applied to this call (for caller diagnostics). */
  thresholds: { refuse: number; confirm: number }
}

/**
 * DG-T1-C — result shape for `action=supersede`. Wraps the supersede() return
 * (which is `{ success, old_id, new_id?, backends?, reason?, error? }`) and
 * exposes `new_id` as `id` so callers that branch on the discriminated union
 * can treat a successful supersede the same way they treat a normal store
 * result. Includes the original `old_id` and `backends` for audit/observability.
 */
export interface SupersedeActionResult {
  status: 'superseded'
  success: boolean
  /** new_id from the underlying supersede() call (the replacement entry). */
  id?: string
  old_id: string
  backends?: string[]
  reason?: string
  error?: string
}

/**
 * DG-T1-C — result shape for `action=update`. Wraps the update() return.
 */
export interface UpdateActionResult {
  status: 'updated'
  success: boolean
  /** The id that was updated (echoed from old_id). */
  id: string
  backends: string[]
  reason?: string
}

/**
 * DG-T1-C — returned when `action` is set but required fields are missing.
 * Distinct from a refuse (the gate found a duplicate); this is "you asked
 * for an action but didn't tell us what to act on".
 */
export interface InvalidActionResponse {
  status: 'invalid_action'
  success: false
  error: string
}

export type UnifiedStoreResult =
  | {
      success: true
      id: string
      storageDecision: StorageDecision
      cached: boolean
      performance: { routingTime: number; storageTime: number; totalTime: number }
    }
  | {
      success: false
      id: string
      storageDecision: StorageDecision
      cached: false
      performance: { routingTime: number; storageTime: number; totalTime: number }
    }
  | DedupRequiredResponse
  | SupersedeActionResult
  | UpdateActionResult
  | InvalidActionResponse

export class UnifiedStoreTool {
  private router: IntelligentStorageRouter
  private storage: {
    mongodb: MongoDBStorage
    graph: GraphStorage
    mem0: Mem0Storage
  }
  private cache: FACTCache
  private ollamaRouter: OllamaStorageRouter | null
  private enrichmentQueue: EnrichmentQueue | null
  private embeddingService: EmbeddingService | null
  private llmJudge: LLMJudgeService | null
  /** Tracks last known availability to detect transitions and log them. */
  private _lastEmbedderAvailable: boolean | null = null

  constructor(
    router: IntelligentStorageRouter,
    storage: { mongodb: MongoDBStorage, graph: GraphStorage, mem0: Mem0Storage },
    cache: FACTCache | null,
    ollamaRouter?: OllamaStorageRouter | null,
    enrichmentQueue?: EnrichmentQueue | null,
    embeddingService?: EmbeddingService | null,
    llmJudge?: LLMJudgeService | null
  ) {
    this.router = router
    this.storage = storage
    this.cache = cache as FACTCache // Now using real cache
    this.ollamaRouter = ollamaRouter ?? null
    this.enrichmentQueue = enrichmentQueue ?? null
    this.embeddingService = embeddingService ?? null
    this.llmJudge = llmJudge ?? null
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
    /**
     * DG-T1-C action dispatch. When the dedup gate returns `dedup_required`,
     * the caller retries with `action` (+ supporting fields) to declare intent:
     *   - 'supersede'  → calls supersede(old_id, new_content, reason). Atomic
     *                    replace: stores new entry with metadata.supersedes,
     *                    flags old as SUPERSEDED. Requires old_id + reason.
     *   - 'update'     → calls update(old_id, content, reason). In-place edit;
     *                    appends to metadata.update_history. Requires old_id +
     *                    reason.
     *   - 'complement' → stores a NEW entry with metadata.related_to=[old_id].
     *                    Skips the dedup gate (caller has acknowledged the
     *                    existing entry and is deliberately adding a related
     *                    one). Requires related_to.
     *   - 'force-new'  → stores a NEW entry with metadata.force_new_reason.
     *                    Skips the dedup gate (caller has justified the
     *                    apparent duplicate). Requires reason.
     *
     * If a required field is missing, returns `{ status: 'invalid_action',
     * success: false, error: ... }` without storing.
     */
    action?: 'supersede' | 'update' | 'complement' | 'force-new'
    old_id?: string
    reason?: string
    related_to?: string
    /**
     * Admin-only escape hatch for batch imports, the reaper, and the
     * calibration script. NOT advertised in the MCP tool schema; only honored
     * when the call comes from a non-Claude-facing code path. Defaults to
     * false (gate enforced).
     */
    options?: {
      skip_dedup?: boolean
      /** Per-call threshold tuning. Both refuse + confirm required (asymmetric rejected). */
      dedup_threshold_override?: { refuse?: number; confirm?: number }
    }
  }): Promise<UnifiedStoreResult> {
    const startTime = Date.now()

    debug(`\n🚀 UNIFIED STORE Starting...`)
    debug(`📝 Content: "${args.content.slice(0, 100)}${args.content.length > 100 ? '...' : ''}"`)

    // ---------------------------------------------------------------------
    // DG-T1-C — action dispatch (issue #46).
    //
    // When the dedup gate returns `dedup_required`, the caller retries with
    // an explicit `action` declaring intent. We dispatch BEFORE inference,
    // embedding, or routing because:
    //   - supersede/update fully delegate to existing methods that own the
    //     full lifecycle (re-embedding, fan-out, rollback), so duplicating
    //     that work here would be wasteful and a source of drift.
    //   - complement/force-new are normal stores with extra metadata + the
    //     dedup gate disabled. We mutate args.metadata + force skip_dedup
    //     here, then fall through to the normal store flow.
    // ---------------------------------------------------------------------
    if (args.action) {
      const dispatchResult = await this._dispatchAction(args)
      if (dispatchResult !== null) {
        // supersede / update / invalid_action all return a terminal result —
        // no fall-through to the normal store path.
        return dispatchResult
      }
      // complement / force-new return null from _dispatchAction after mutating
      // args; fall through to the normal store path with the modified args.
    }

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

    // ---------------------------------------------------------------------
    // Pre-store: generate embedding (DG-T1-A)
    //
    // We compute the vector BEFORE the storage fan-out so that metadata
    // bookkeeping (embedder_id, embedded_at) ships with the initial record
    // — no second write to patch metadata. The vector bytes themselves are
    // attached to the SparrowDB node in a SET call AFTER the graph store
    // (the node has to exist first).
    //
    // Failures are non-fatal: a backfill job can re-embed later. The dedup
    // gate retrieval path (DG-T1-B) treats "no embedder_id" as "skip dedup
    // check" so we degrade gracefully when Ollama is down.
    // ---------------------------------------------------------------------
    let pendingEmbedding: Float32Array | null = null
    let pendingEmbedderId: string | null = null
    if (this.embeddingService) {
      // Check liveness before attempting embed. isAvailable() uses a 500 ms
      // probe cached for 30 s, so on the cold-unavailable path this costs
      // ~500 ms instead of the full 5 s embed timeout. The first transition
      // (available → unavailable or vice-versa) is logged so ops can see when
      // Ollama comes back up.
      const embedderAvailable = await this.embeddingService.isAvailable()
      if (this._lastEmbedderAvailable !== embedderAvailable) {
        if (embedderAvailable) {
          console.info('[unified_store] Embedding service is now AVAILABLE')
        } else {
          console.warn('[unified_store] Embedding service is now UNAVAILABLE — skipping embed (backfill will re-embed later)')
        }
        this._lastEmbedderAvailable = embedderAvailable
      }

      if (embedderAvailable) {
        try {
          const vec = await this.embeddingService.embed(knowledge.content)
          pendingEmbedding = vec
          pendingEmbedderId = this.embeddingService.embedderId
          knowledge.metadata = {
            ...knowledge.metadata,
            embedder_id: this.embeddingService.embedderId,
            embedded_at: new Date().toISOString()
          }
          debug(`🧬 Embedded content (${vec.length}d) — embedderId=${this.embeddingService.embedderId}`)
        } catch (e) {
          // Ollama unreachable / dim mismatch / etc. Log and continue —
          // the store path must succeed even when the embedder is down.
          console.warn(
            `⚠️  unified_store: embedding failed (continuing without embed): ` +
            `${e instanceof Error ? e.message : String(e)}`
          )
        }
      }
    }

    // ---------------------------------------------------------------------
    // Dedup gate (DG-T1-B) — Tier 1 vector similarity check
    //
    // Runs BEFORE the storage fan-out. If a near-duplicate exists for the
    // same userId+contentType+(optional subject), we refuse the additive
    // write and return `dedup_required` so the caller is forced to choose
    // an explicit action (supersede/update/complement/force-new).
    //
    // Skipped when:
    //   - options.skip_dedup === true (admin escape hatch, also set by the
    //     DG-T1-C dispatcher for action=complement / action=force-new)
    //   - no embedding was generated (Ollama down, dim mismatch, etc.)
    //   - the graph backend doesn't expose findSimilar (older binding)
    //
    // Latency: typical p50 ~5-15 ms (HNSW search 1-3 ms + JS post-filter).
    // ---------------------------------------------------------------------
    const skipDedup = args.options?.skip_dedup === true
    if (
      pendingEmbedding &&
      !skipDedup &&
      typeof (this.storage.graph as any).findSimilar === 'function'
    ) {
      const subjectFacet = typeof knowledge.metadata?.subject === 'string'
        ? knowledge.metadata.subject
        : undefined

      const { refuse: refuseThreshold, confirm: confirmThreshold } = resolveDedupThresholds(
        knowledge.contentType,
        args.options?.dedup_threshold_override
      )

      try {
        const candidates = await (this.storage.graph as any).findSimilar(
          pendingEmbedding,
          {
            userId: knowledge.userId,
            contentType: knowledge.contentType,
            subject: subjectFacet,
            topK: 5
          }
        ) as Array<{
          id: string
          similarity: number
          contentType: string
          source: string
          subject?: string
          created: string
          flag?: string | null
          content_preview: string
        }>

        if (candidates && candidates.length > 0) {
          const top = candidates[0]
          const inRefuse = top.similarity >= refuseThreshold
          const inConfirm = !inRefuse && top.similarity >= confirmThreshold

          if (inRefuse || inConfirm) {
            const band: 'refuse' | 'confirm' = inRefuse ? 'refuse' : 'confirm'
            const msg = inRefuse
              ? `Likely duplicate found (cos=${top.similarity.toFixed(3)} ≥ ${refuseThreshold}). Retry with action.`
              : `Borderline match found (cos=${top.similarity.toFixed(3)} in [${confirmThreshold}, ${refuseThreshold})). Retry with action to confirm intent.`

            // -------------------------------------------------------------
            // Tier 2 LLM judge (DG-T2-A) — classify candidate relationships
            //
            // For each candidate decide its `llm_relation`:
            //   - sim ≥ refuseThreshold → 'duplicate' inline (cost-free; the
            //     embedder agrees so strongly we don't need the LLM)
            //   - confirmThreshold ≤ sim < refuseThreshold → call judge
            //   - judge unavailable → null for all
            //   - per-candidate classify failure → null for that one only
            //
            // All confirm-band classifications run in parallel because they
            // are independent. Hard 5s timeout enforced by the judge itself.
            // -------------------------------------------------------------
            const llmRelations: Array<LLMRelation | null> = candidates.map(c =>
              c.similarity >= refuseThreshold ? 'duplicate' : null
            )

            if (this.llmJudge) {
              let judgeAvailable = false
              try {
                judgeAvailable = await this.llmJudge.isAvailable()
              } catch (e) {
                logger.warn(
                  `unified_store: llmJudge.isAvailable() threw (skipping Tier 2): ` +
                  `${e instanceof Error ? e.message : String(e)}`
                )
              }

              if (judgeAvailable) {
                const confirmBandIndices: number[] = []
                candidates.forEach((c, idx) => {
                  if (c.similarity < refuseThreshold && c.similarity >= confirmThreshold) {
                    confirmBandIndices.push(idx)
                  }
                })

                if (confirmBandIndices.length > 0) {
                  // Hydrate full content for each confirm-band candidate before
                  // classification. content_preview is capped at 200 chars which
                  // can cause misclassification on longer entries. Fall back to
                  // content_preview if the graph backend doesn't expose findById
                  // or the entry is unexpectedly missing.
                  const graph = this.storage.graph as any
                  const hasGraphFindById = typeof graph.findById === 'function'
                  const fullContents: Record<number, string> = {}
                  for (const idx of confirmBandIndices) {
                    let full = candidates[idx].content_preview
                    if (hasGraphFindById) {
                      try {
                        const entry = await graph.findById(candidates[idx].id)
                        if (entry && typeof entry.content === 'string' && entry.content.length > 0) {
                          full = entry.content
                        }
                      } catch {
                        // Non-fatal — fall back to content_preview
                      }
                    }
                    fullContents[idx] = full
                  }

                  // Resolve in parallel — independent calls, the LLMJudgeService
                  // owns its own timeout. We use Promise.allSettled so a single
                  // failure doesn't drop the others.
                  const judge = this.llmJudge
                  const results = await Promise.allSettled(
                    confirmBandIndices.map(idx => judge.classify({
                      newContent: knowledge.content,
                      candidateContent: fullContents[idx],
                    }))
                  )
                  results.forEach((r, i) => {
                    const idx = confirmBandIndices[i]
                    if (r.status === 'fulfilled') {
                      llmRelations[idx] = r.value
                    } else {
                      // Per-candidate failure: log and leave null — other
                      // candidates' results still ship.
                      logger.warn(
                        `unified_store: llmJudge.classify failed for candidate ${candidates[idx].id} ` +
                        `(continuing with llm_relation=null): ` +
                        `${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
                      )
                    }
                  })
                  debug(
                    `🤖 Tier 2 judge classified ${confirmBandIndices.length} confirm-band candidate(s) ` +
                    `(model=${this.llmJudge.modelId})`
                  )
                }
              } else {
                debug(`🤖 Tier 2 judge unavailable — leaving llm_relation=null for confirm-band candidates`)
              }
            }

            const oldIdHint = top.id
            const response: DedupRequiredResponse = {
              status: 'dedup_required',
              candidates: candidates.map((c, idx) => ({
                id: c.id,
                similarity: c.similarity,
                content_preview: c.content_preview,
                contentType: c.contentType,
                source: c.source,
                subject: c.subject,
                created: c.created,
                flag: c.flag ?? null,
                llm_relation: llmRelations[idx]
              })),
              message: msg,
              retry_with: [
                `action=supersede&old_id=${oldIdHint}&reason=<...>`,
                `action=update&old_id=${oldIdHint}&reason=<...>`,
                `action=complement&related_to=${oldIdHint}`,
                `action=force-new&reason=<justification>`
              ],
              band,
              thresholds: { refuse: refuseThreshold, confirm: confirmThreshold }
            }
            debug(
              `🛑 DEDUP GATE refused write (${band}): top sim=${top.similarity.toFixed(3)} ` +
              `against id=${top.id}; ${candidates.length} candidate(s)`
            )
            return response
          }
        }
      } catch (e) {
        // Non-fatal: degrade to "no dedup check" rather than blocking the write.
        console.warn(
          `⚠️ unified_store: findSimilar failed (continuing without dedup): ` +
          `${e instanceof Error ? e.message : String(e)}`
        )
      }
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

    // -----------------------------------------------------------------
    // Embedding handoff to SparrowDB graph store (DG-T1-A inline path).
    //
    // SparrowDB 0.1.22's HNSW vector index is populated only when the
    // embedding appears as a $param INSIDE a MERGE/CREATE pattern's literal
    // property dict. Compound MERGE+SET parses but the SET clause silently
    // no-ops; MATCH+SET (the previous storeEmbedding shape) also silently
    // no-ops — neither stores the property NOR populates HNSW. Verified
    // via direct repro and reported upstream (channel msg #202).
    //
    // Workaround: thread the vector through transient metadata keys that
    // SparrowDBStorage.store() plucks off before the sidecar write. Don't
    // attach to mem0/mongo paths — those would just persist the vector as
    // a noisy metadata field. Restored after fan-out so non-graph backends
    // see clean metadata.
    // -----------------------------------------------------------------
    // Transient handoff keys live in ../embedding/EmbeddingService.ts so the
    // producer (here) and consumer (SparrowDBStorage.store) share one source
    // of truth — see PR #69 review feedback.

    // Helper: clone knowledge with the embedding payload spliced into metadata.
    // We use a clone (not in-place mutation) so non-graph backends see clean
    // metadata without needing finally-block scrubbing — and so any later
    // observers of the original `knowledge` (cache writer, return-value
    // builder) don't see the transient fields.
    const withEmbeddingHandoff = (k: typeof knowledge) => ({
      ...k,
      metadata: {
        ...k.metadata,
        [PENDING_EMBEDDING_KEY]: pendingEmbedding,
        [PENDING_EMBEDDER_ID_KEY]: pendingEmbedderId
      }
    })

    try {
      // Store in primary system
      if (primarySystem === 'graph' && pendingEmbedding && pendingEmbedderId) {
        await this.storeInSystem(withEmbeddingHandoff(knowledge), primarySystem)
      } else {
        await this.storeInSystem(knowledge, primarySystem)
      }

      // Store in secondary systems (for cross-linking)
      if (secondarySystems.length > 0) {
        debug(`\n🔗 Cross-linking to secondary systems...`)
        await Promise.all(
          secondarySystems.map(async (system) => {
            try {
              if (system === 'graph' && pendingEmbedding && pendingEmbedderId) {
                await this.storeInSystem(withEmbeddingHandoff(knowledge), system)
              } else {
                await this.storeInSystem(knowledge, system)
              }
              debug(`✅ Cross-stored in ${system}`)
            } catch (error) {
              console.warn(`⚠️ Failed to cross-store in ${system}:`, error instanceof Error ? error.message : String(error))
            }
          })
        )
      }

      // Queue enrichment once for the primary system (same content — no need to repeat per secondary)
      if (this.enrichmentQueue) {
        this.enrichmentQueue.add(knowledge.id, knowledge.content, primarySystem as 'mongodb' | 'mem0' | 'graph')
      }

      // -----------------------------------------------------------------
      // Belt-and-suspenders: if the graph backend is not the primary or a
      // secondary target (e.g. mem0-only routing) but we still have an
      // embedding, populate the graph node anyway so the dedup gate can
      // see it on the next call. Currently routes always include graph,
      // so this is a defensive no-op until/unless that changes — but cheap.
      // -----------------------------------------------------------------
      const graphTouched = primarySystem === 'graph' || secondarySystems.includes('graph')
      if (!graphTouched && pendingEmbedding && pendingEmbedderId) {
        const graphAny = this.storage.graph as any
        if (typeof graphAny.storeEmbedding === 'function') {
          try {
            const ok = await graphAny.storeEmbedding(
              knowledge.id, pendingEmbedding, pendingEmbedderId
            )
            if (!ok) {
              debug(`⚠️ storeEmbedding fallback returned false for ${knowledge.id}`)
            }
          } catch (e) {
            console.warn(
              `⚠️  unified_store: storeEmbedding fallback failed (non-fatal): ` +
              `${e instanceof Error ? e.message : String(e)}`
            )
          }
        }
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
   * DG-T1-C action dispatch (issue #46).
   *
   * Called from store() when args.action is set. Returns one of:
   *   - A terminal `UnifiedStoreResult` (supersede/update/invalid) — the
   *     caller returns this directly without falling through to the normal
   *     store flow.
   *   - `null` (complement/force-new) — args has been mutated in place
   *     (metadata + options.skip_dedup) and the caller continues with the
   *     normal store flow, which now skips the dedup gate.
   *
   * The two terminal actions delegate to existing methods (supersede() and
   * update()) so this layer stays thin: it validates inputs, calls the
   * heavy lifter, and adapts the response into UnifiedStoreResult.
   */
  private async _dispatchAction(args: {
    content: string
    contentType?: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'
    source?: 'personal' | 'technical' | 'cross_domain'
    userId?: string
    metadata?: Record<string, any>
    confidence?: number
    action?: 'supersede' | 'update' | 'complement' | 'force-new'
    old_id?: string
    reason?: string
    related_to?: string
    options?: { skip_dedup?: boolean; dedup_threshold_override?: { refuse?: number; confirm?: number } }
  }): Promise<UnifiedStoreResult | null> {
    const action = args.action!
    console.info(`[unified_store] action="${action}" — DG-T1-C dispatch engaged`)

    switch (action) {
      case 'supersede': {
        if (!args.old_id || !args.reason) {
          return {
            status: 'invalid_action',
            success: false,
            error: `action=supersede requires both 'old_id' and 'reason'. See retry_with hint from the prior dedup_required response.`
          }
        }
        const r = await this.supersede({
          old_id: args.old_id,
          new_content: args.content,
          contentType: args.contentType,
          source: args.source,
          userId: args.userId,
          confidence: args.confidence,
          metadata: args.metadata,
          reason: args.reason
        })
        return {
          status: 'superseded',
          success: r.success,
          // Expose new_id as `id` so callers branching on the union can
          // treat a successful supersede the same as a normal store.
          id: r.new_id,
          old_id: r.old_id,
          backends: r.backends,
          reason: r.reason,
          error: r.error
        }
      }

      case 'update': {
        if (!args.old_id || !args.reason) {
          return {
            status: 'invalid_action',
            success: false,
            error: `action=update requires both 'old_id' and 'reason'. See retry_with hint from the prior dedup_required response.`
          }
        }
        // update() accepts content as an optional field; we pass it through
        // so callers can correct typos in one round-trip without an extra
        // store. The spec didn't preclude this and the existing update()
        // already handles content updates cleanly.
        const r = await this.update({
          id: args.old_id,
          content: args.content,
          metadata: args.metadata,
          confidence: args.confidence,
          reason: args.reason
        })
        return {
          status: 'updated',
          success: r.success,
          id: r.id,
          backends: r.backends,
          reason: r.reason
        }
      }

      case 'complement': {
        if (!args.related_to) {
          return {
            status: 'invalid_action',
            success: false,
            error: `action=complement requires 'related_to' (the id of the existing entry being complemented). See retry_with hint from the prior dedup_required response.`
          }
        }
        // Mutate args so the normal store flow stores a NEW entry with the
        // bidirectional link injected and the dedup gate disabled (the
        // caller has explicitly acknowledged the candidate). related_to is
        // an array so a future write can complement multiple entries; we
        // merge with any existing array the caller may have set.
        const priorRelatedTo = Array.isArray(args.metadata?.related_to)
          ? args.metadata!.related_to as string[]
          : []
        args.metadata = {
          ...(args.metadata || {}),
          related_to: priorRelatedTo.includes(args.related_to)
            ? priorRelatedTo
            : [...priorRelatedTo, args.related_to]
        }
        args.options = { ...(args.options || {}), skip_dedup: true }

        // Best-effort reverse link in the graph. Spec asks for "bidirectional
        // link"; the forward link (metadata.related_to on the new entry) is
        // guaranteed by the store path. The reverse link is a graph-only
        // concern and may not be supported by every backend, so we attempt
        // it post-store via the graph's _createRelationship hook if present.
        // Wiring deferred to a follow-up so this path stays additive: the
        // forward link alone is sufficient for the dedup gate's audit
        // trail and downstream readers.
        debug(`🔗 complement: forward-link injected (related_to=${args.related_to}); reverse-link is best-effort and not yet wired`)

        return null  // fall through to normal store
      }

      case 'force-new': {
        if (!args.reason) {
          return {
            status: 'invalid_action',
            success: false,
            error: `action=force-new requires 'reason' (justification for storing despite the apparent duplicate). See retry_with hint from the prior dedup_required response.`
          }
        }
        // Mutate args: stamp the justification into metadata so the audit
        // trail explains why this write bypassed the gate, and disable the
        // gate for this call.
        args.metadata = {
          ...(args.metadata || {}),
          force_new_reason: args.reason
        }
        args.options = { ...(args.options || {}), skip_dedup: true }
        return null  // fall through to normal store
      }

      default: {
        // TypeScript exhaustiveness check — unreachable if the union stays
        // in sync. If a future contributor adds a new action without
        // updating this switch, this returns a clear error rather than
        // silently falling through.
        const _exhaustive: never = action
        return {
          status: 'invalid_action',
          success: false,
          error: `Unknown action: ${String(_exhaustive)}`
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
      case 'graph':
        await this.storage.graph.store(knowledge)
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
    if (args.confidence !== undefined) updates.confidence = args.confidence

    // Fetch existing record so we can merge metadata instead of overwriting it.
    // This prevents $set from dropping existing metadata keys and prior
    // update_history entries that the caller did not include in args.metadata.
    let existingMetadata: Record<string, any> = {}
    try {
      const existing = await this.storage.mongodb.findById(args.id)
      if (existing?.metadata) existingMetadata = existing.metadata as Record<string, any>
    } catch (e) {
      console.warn('⚠️  unified_update: could not fetch existing metadata for merge (non-fatal):', e)
    }

    // Merge: existing metadata base, then caller-supplied overrides, then
    // append the new audit entry to update_history (preserving prior entries).
    const mergedMetadata: Record<string, any> = {
      ...existingMetadata,
      ...(args.metadata || {})
    }
    if (args.reason) {
      const prior = Array.isArray(mergedMetadata.update_history) ? mergedMetadata.update_history : []
      mergedMetadata.update_history = [...prior, { at: new Date().toISOString(), reason: args.reason }]
    }
    updates.metadata = mergedMetadata

    const backends: string[] = []

    if (typeof (this.storage.graph as any).update === 'function') {
      try {
        const ok = await (this.storage.graph as any).update(args.id, updates)
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

    // Invalidate cache after any successful backend update so stale search
    // results and knowledge cache entries don't serve pre-update content.
    if (backends.length > 0 && this.cache) {
      try {
        await this.cache.invalidate('kms:search:*')
        await this.cache.invalidate(`*${args.id}*`)
      } catch { /* non-fatal */ }
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

    if (typeof (this.storage.graph as any).flag === 'function') {
      try {
        const ok = await (this.storage.graph as any).flag(
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
   * Probe each backend for whether `id` exists. Returns the set of backend
   * names where the entry is present. Used by supersede() to compute the
   * `requiredBackends` set — i.e. the backends whose flag() must succeed for
   * the operation to be considered atomic.
   *
   * Why this is needed: `IntelligentStorageRouter` (and `OllamaStorageRouter`)
   * route many entries to graph + mem0 only, skipping MongoDB unless the
   * content matches procedure/technical/MONGODB_PATTERN heuristics. A naïve
   * "flag every backend, require every flag to succeed" supersede then fails
   * on graph-only entries because mongo.flag() returns false (entry not
   * present), even though the supersede succeeded everywhere it needed to.
   *
   * Mem0 deliberately omitted: supersede does not flag Mem0 (Mem0 has no flag
   * concept), so its existence does not factor into the success criterion.
   */
  private async _existsInBackends(id: string): Promise<{
    inGraph: boolean
    inMongo: boolean
  }> {
    let inGraph = false
    let inMongo = false

    if (typeof (this.storage.graph as any).findById === 'function') {
      try {
        // SparrowDBStorage.findById is sync (returns ContentEntry | null);
        // GraphStorage interface allows async. `await` resolves both.
        const entry = await (this.storage.graph as any).findById(id)
        inGraph = entry !== null && entry !== undefined
      } catch (e) {
        // Treat probe error as "not found" — supersede will short-circuit if
        // both backends report missing, which is the correct behavior for a
        // truly missing id. Log so ops can see if probes are flaky.
        debug(`supersede: graph.findById(${id}) errored — treating as not-present:`, e)
      }
    }

    try {
      const entry = await this.storage.mongodb.findById(id)
      inMongo = entry !== null && entry !== undefined
    } catch (e) {
      debug(`supersede: mongodb.findById(${id}) errored — treating as not-present:`, e)
    }

    return { inGraph, inMongo }
  }

  /**
   * Atomic supersede: store a new entry, then flag the old one as SUPERSEDED
   * with a back-link to the new entry. The new entry's metadata gets a forward
   * link (`supersedes`) for bidirectional chain tracing.
   *
   * Routing-aware (issue #62): the storage router only writes to MongoDB for
   * a subset of contentTypes (procedure / source=technical / MONGODB_PATTERN
   * keywords). Entries routed to graph + mem0 only do not exist in MongoDB,
   * so requiring MongoDB.flag success would silently fail and roll back — the
   * exact bug DG-INV-2 found 4 historical orphans of. Fix: query each backend
   * for the entry first, build a `requiredBackends` set, and require all-of
   * THAT set to succeed (option (b) in issue #62).
   *
   * If flagging fails on any required backend, rolls back: hard-deletes the
   * new entry, un-flags any backend whose flag succeeded. Returns the new
   * entry's ID on success.
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
    // Step 0: probe backends to find out where the old entry actually lives.
    // We do this BEFORE storing the new entry so we can fail fast (and avoid
    // a wasted store + rollback) when old_id is wrong / truly missing.
    const presence = await this._existsInBackends(args.old_id)
    const requiredBackends: string[] = []
    if (presence.inGraph) requiredBackends.push('sparrowdb')
    if (presence.inMongo) requiredBackends.push('mongodb')

    if (requiredBackends.length === 0) {
      return {
        success: false,
        old_id: args.old_id,
        error: `supersede: old_id ${args.old_id} not found in any backend (checked: sparrowdb, mongodb). Verify the id is correct.`
      }
    }

    debug(`🔁 supersede: old_id=${args.old_id} present in [${requiredBackends.join(', ')}] — requiring flag success on these only`)

    // Step 1: store the new entry (with forward-link to the old one).
    // skip_dedup: true — supersede is itself the corrective action that the
    // dedup gate would suggest; running it through the gate would either
    // self-refer (the new content is similar to the entry being superseded)
    // or block valid corrections.
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
      },
      options: { skip_dedup: true }
    })

    // Discriminate the result. supersede() calls store() with skip_dedup:true,
    // so dedup_required cannot be returned here — but TS still needs the guard.
    if (!('success' in storeResult) || !storeResult.success) {
      return {
        success: false,
        old_id: args.old_id,
        error: 'Failed to store new entry'
      }
    }

    const new_id = storeResult.id

    // Step 2: flag the old entry as SUPERSEDED with back-link to the new one.
    // Only flag the backends where the entry actually exists. Skip the others
    // — flagging an absent entry would fail with "not found" and incorrectly
    // trigger rollback for routing-asymmetric entries (e.g. graph-only).
    const flagNote = args.reason || `Superseded by ${new_id}`
    const flaggedBackends: string[] = []
    const failedBackends: string[] = []

    if (presence.inGraph && typeof (this.storage.graph as any).flag === 'function') {
      try {
        const ok = await (this.storage.graph as any).flag(
          args.old_id, 'SUPERSEDED', flagNote, undefined, new_id
        )
        if (ok) flaggedBackends.push('sparrowdb')
        else failedBackends.push('sparrowdb')
      } catch (e) {
        failedBackends.push('sparrowdb')
        console.warn(`⚠️  unified_supersede SparrowDB flag error:`, e)
      }
    } else if (!presence.inGraph) {
      debug(`supersede: entry ${args.old_id} not in sparrowdb, skipping flag on that backend`)
    }

    if (presence.inMongo) {
      try {
        const ok = await this.storage.mongodb.flag(
          args.old_id, 'SUPERSEDED', flagNote, undefined, new_id
        )
        if (ok) flaggedBackends.push('mongodb')
        else failedBackends.push('mongodb')
      } catch (e) {
        failedBackends.push('mongodb')
        console.warn(`⚠️  unified_supersede MongoDB flag error:`, e)
      }
    } else {
      debug(`supersede: entry ${args.old_id} not in mongodb, skipping flag on that backend`)
    }

    // Invalidate cache after flagging (mirrors flag() behavior).
    if (this.cache) {
      try {
        await this.cache.invalidate('kms:search:*')
        await this.cache.invalidate(`*${args.old_id}*`)
      } catch { /* non-fatal */ }
    }

    if (failedBackends.length > 0) {
      // Rollback: hard-delete the new entry so we don't leave a dangling
      // replacement. Surface the real failure reason for the caller.
      console.warn(`⚠️  unified_supersede rollback: flag failed on [${failedBackends.join(', ')}], deleting new entry ${new_id}`)
      try {
        if (typeof (this.storage.graph as any).delete === 'function') {
          await (this.storage.graph as any).delete(new_id)
        }
        await this.storage.mongodb.delete(new_id)
        await this.storage.mem0.deleteMemory(new_id).catch(() => {})
        // Undo any flag that did succeed so backends stay in sync.
        for (const backend of flaggedBackends) {
          if (backend === 'sparrowdb' && typeof (this.storage.graph as any).flag === 'function') {
            await (this.storage.graph as any).flag(args.old_id, null).catch(() => {})
          } else if (backend === 'mongodb') {
            await this.storage.mongodb.flag(args.old_id, null).catch(() => {})
          }
        }
      } catch (e) {
        console.error('❌ unified_supersede rollback failed:', e)
      }
      return {
        success: false,
        old_id: args.old_id,
        error: `Flag step failed on backend(s): [${failedBackends.join(', ')}] for entry ${args.old_id} (backend write error or race). New entry ${new_id} was rolled back — retry may succeed if this was transient.`
      }
    }

    return {
      success: true,
      old_id: args.old_id,
      new_id,
      backends: flaggedBackends,
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
    if (typeof (this.storage.graph as any).listFlagged === 'function') {
      try {
        const flagged = await (this.storage.graph as any).listFlagged() as Array<any>
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
      if (typeof (this.storage.graph as any).delete === 'function') {
        try {
          const ok = await (this.storage.graph as any).delete(c.id)
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
