/**
 * Mem0 Storage System Implementation
 *
 * Targets mem0ai SDK v3.x (verified against 3.0.2). v1 → v3 contract deltas:
 *  - `add(messages, options)`: top-level `userId` or `user_id` BOTH allowed
 *    (SDK runs camelToSnakeKeys on the merged payload). No rejectTopLevelEntityParams.
 *  - `search(query, options)`: REJECTS top-level entity params via
 *    rejectTopLevelEntityParams() as the very first line. {user_id, agent_id,
 *    app_id, run_id} MUST be passed inside `filters: { ... }`. Throws otherwise.
 *  - `getAll(options)`: same rejection as search. `filters: { user_id }` required.
 *    Returns PaginatedMemories `{ count, next, previous, results }` (was bare array).
 *  - `search`: `limit` → `topK`, `api_version` removed (always /v3/memories/search/).
 *    Return shape `{ results: Memory[] }`.
 *  - `get(memoryId)` only takes a string. The 1.x `get({ user_id, limit })`
 *    overload moved to `getAll(options)`.
 *  - Response keys converted snake → camel by SDK (`createdAt`, `updatedAt`, `userId`).
 *  - `enable_graph` no longer a recognized option (none in this codebase).
 *
 * Verification anchors:
 *  - `node_modules/mem0ai/dist/index.mjs` — rejectTopLevelEntityParams as first line of search/getAll
 *  - `mem0` CLI (npm i -g @mem0/cli) — translates --user-id to filters.user_id
 *  - Live `kms_ping` previously threw on getStats top-level user_id (caught + fixed 2026-05-07)
 */

import { MemoryClient, Memory } from 'mem0ai'
import { StorageSystem, UnifiedKnowledge, KnowledgeQuery, KMSConfig } from '../types/index.js'

export class Mem0Storage implements StorageSystem {
  public name = 'mem0'
  private client!: MemoryClient

  constructor(private config: KMSConfig['mem0']) {}

  async initialize(): Promise<void> {
    console.log('🧠 Connecting to Mem0...')

    // Initialize Mem0 client with telemetry disabled for Node.js environment
    try {
      // Disable Mem0 telemetry in Node.js environment
      process.env.MEM0_TELEMETRY = 'false'

      // Mock window object for Mem0 SDK telemetry
      if (typeof (global as any).window === 'undefined') {
        (global as any).window = {
          crypto: {
            subtle: {
              digest: async () => new ArrayBuffer(32)
            }
          },
          navigator: {
            userAgent: 'Node.js'
          }
        }
      }

      const { MemoryClient } = await import('mem0ai')
      this.client = new MemoryClient({
        apiKey: this.config.apiKey
      })

      console.log('✅ Mem0 connected successfully')
    } catch (error) {
      console.error('❌ Mem0 connection error:', error)
      throw error
    }
  }

  async store(knowledge: UnifiedKnowledge): Promise<void> {
    try {
      console.log(`🧠 Storing in Mem0: ${knowledge.id}`)

      const userId = this.generateUserId(knowledge)

      // Mem0 v3 add expects `user_id` (snake) at top level — NOT `userId` (camel).
      // Same shape as v3 search/getAll (see Mem0Storage.search above and PR #59):
      // the SDK forwards options to the wire as-is for /v1/memories/, and the
      // server requires one of {agent_id, user_id, app_id, run_id} at body root
      // ("non_field_errors: At least one of the filters: ... is required!"
      // observed live in production after the search/getAll fix shipped, since
      // add was overlooked in PR #59). camelCase `userId` is silently dropped.
      const messages = [{
        role: 'user' as const,
        content: knowledge.content
      }]
      const options: any = {
        user_id: userId,
        metadata: {
          kms_id: knowledge.id,
          content_type: knowledge.contentType,
          source: knowledge.source,
          confidence: knowledge.confidence,
          timestamp: knowledge.timestamp.toISOString(),
          ...knowledge.metadata
        }
      }

      await this.client.add(messages, options)
      console.log(`✅ Successfully stored in Mem0 for user: ${userId}`)
    } catch (error) {
      console.error('❌ Mem0 storage error:', error)
      throw error
    }
  }

  async search(query: KnowledgeQuery): Promise<any[]> {
    try {
      console.log(`🔍 Searching Mem0: "${query.query}"`)

      const userId = this.generateUserIdFromQuery(query)
      console.log(`🧠 [Mem0Storage.search] Using user ID: ${userId}`)

      const searchQuery = query.query
      // Mem0 v3 SDK: search() throws via rejectTopLevelEntityParams() if any of
      // {user_id, agent_id, app_id, run_id} appear at TOP LEVEL of options.
      // Entity-scope MUST go inside `filters`. Verified 2026-05-07 against
      // mem0ai@3.0.2 SDK source (rejectTopLevelEntityParams runs as the FIRST
      // line of search()) and against the live `mem0` CLI (which translates
      // --user-id to filters.user_id internally and works correctly).
      // Previous implementation passed user_id at top level → SDK threw →
      // outer try/catch swallowed → returned [] → Mem0 dimension of dedup
      // gate has been silently dark since the 1.x→3.x cutover.
      const searchOptions = {
        topK: query.options?.maxResults || 10,
        filters: { user_id: userId, ...this.buildMem0Filters(query.filters) }
      }

      console.log(`🧠 [Mem0Storage.search] Search query: "${searchQuery}"`)
      console.log(`🧠 [Mem0Storage.search] Search options:`, JSON.stringify(searchOptions, null, 2))

      // SDK type declares `Memory[]` but runtime can be either bare array or
      // `{ results: Memory[] }` depending on endpoint version — handle both.
      type Mem0SearchResponse = any[] | { results?: any[] }
      const response = await this.client.search(searchQuery, searchOptions) as unknown as Mem0SearchResponse
      const results: any[] = Array.isArray(response) ? response : (response?.results ?? [])

      const processedResults = results.map((r: any) => ({
        id: r.id || r.metadata?.kms_id,
        content: r.memory || '',
        confidence: r.score || r.metadata?.confidence || 0.5,
        metadata: r.metadata || {},
        sourceSystem: 'mem0',
        timestamp: r.metadata?.timestamp ? new Date(r.metadata.timestamp) : new Date(),
        contentType: r.metadata?.content_type,
        source: r.metadata?.source,
        userId: r.userId ?? r.user_id
      }))

      console.log(`🧠 Mem0 found ${processedResults.length} results`)
      return processedResults
    } catch (error) {
      console.warn('⚠️ Mem0 search error:', error)
      return []
    }
  }

  async getStats(): Promise<Record<string, any>> {
    try {
      // v3 SDK: use getAll() with filters.user_id and page_size=1 to get the count.
      // user_id MUST be inside filters — getAll() throws via rejectTopLevelEntityParams
      // if it appears at top level (verified against mem0ai@3.0.2 source).
      const userId = this.config.defaultUserId || 'personal'
      type Mem0GetAllResponse = any[] | { count?: number; results?: any[]; next?: string | null; previous?: string | null }
      const page = await this.client.getAll({
        page: 1,
        page_size: 1,
        filters: { user_id: userId }
      } as any) as unknown as Mem0GetAllResponse
      // Paginated response: { count, next, previous, results }. Bare array fallback for non-paginated.
      const totalMemories = (Array.isArray(page) ? page.length : page?.count) ?? 'unknown'
      return {
        totalMemories,
        userId,
        status: 'connected',
        apiEndpoint: 'Mem0 Cloud (v3)'
      }
    } catch (error) {
      console.error('❌ Mem0 stats error:', error)
      return {
        totalMemories: 'unknown',
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async getMemoriesForUser(userId: string, limit = 50): Promise<any[]> {
    try {
      // v3 SDK contract: user_id inside filters, NOT top level.
      // (See getStats above for the SDK-source rationale.)
      type Mem0GetAllResponse = any[] | { count?: number; results?: any[] }
      const page = await this.client.getAll({
        page: 1,
        page_size: limit,
        filters: { user_id: userId }
      } as any) as unknown as Mem0GetAllResponse

      // getAll runtime shape varies (bare array vs { results: [...], count }).
      const memList: any[] = Array.isArray(page) ? page : (page?.results ?? [])
      return memList.map((m: any) => {
        const created = m.createdAt ?? m.created_at
        const updated = m.updatedAt ?? m.updated_at
        return {
          id: m.id,
          content: m.memory,
          metadata: m.metadata,
          userId: m.userId ?? m.user_id,
          createdAt: created ? new Date(created) : undefined,
          updatedAt: updated ? new Date(updated) : undefined
        }
      })
    } catch (error) {
      console.error('❌ Mem0 getMemoriesForUser error:', error)
      return []
    }
  }

  async getById(memoryId: string): Promise<any> {
    try {
      console.log(`🧠 [Mem0Storage.getById] Starting retrieval for memory ID: ${memoryId}`)
      console.log(`🧠 [Mem0Storage.getById] Memory ID type: ${typeof memoryId}`)
      console.log(`🧠 [Mem0Storage.getById] Memory ID length: ${memoryId?.length}`)

      // v3: client.get(memoryId: string) returns a single Memory object (or throws on 404).
      console.log(`🧠 [Mem0Storage.getById] Calling this.client.get(${memoryId})...`)
      const memory = await this.client.get(memoryId)
      console.log(`🧠 [Mem0Storage.getById] SDK response:`, memory)

      if (memory) {
        console.log(`✅ [Mem0Storage.getById] Found memory ${memoryId}`)
        return memory
      } else {
        console.log(`🧠 [Mem0Storage.getById] Memory ${memoryId} not found (empty response)`)
        throw new Error(`Memory with ID ${memoryId} not found`)
      }
    } catch (error) {
      console.error(`❌ [Mem0Storage.getById] Error retrieving memory ${memoryId}:`, error)
      console.error(`❌ [Mem0Storage.getById] Error stack:`, error instanceof Error ? error.stack : 'No stack trace')
      throw error
    }
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    try {
      await this.client.delete(memoryId)
      return true
    } catch (error) {
      console.error('❌ Mem0 delete error:', error)
      return false
    }
  }

  /**
   * Update an existing Mem0 entry by KMS id (kms_update propagation).
   *
   * Why this exists: kms_update mutates content + metadata in Mongo and
   * SparrowDB, but historically skipped Mem0 — the rationale was "Mem0
   * memories are LLM-managed and re-extracted on next store". In practice
   * this caused Mem0's corpus to drift from corrected truth: a fact
   * superseded or rewritten in Mongo would still surface its outdated form
   * via Mem0 search (and via the kms-context-fetch hook). By calling Mem0's
   * own update endpoint with the new text, we let Mem0's LLM re-extract a
   * coherent memory from the corrected content rather than continuing to
   * surface the stale extraction.
   *
   * Mem0 indexes by its own internal id, NOT the KMS id. The mapping is
   * one-way: at store() time we set `metadata.kms_id = knowledge.id` on the
   * Mem0 record but we never persisted Mem0's returned id back into our
   * canonical record. So here we look the Mem0 id up via search-and-filter:
   *
   *   1. Search Mem0 with the kms id as the query, scoped to user_id.
   *      Mem0 stores metadata as searchable text, so the kms id usually
   *      surfaces the right entry near the top.
   *   2. Filter results client-side for `metadata.kms_id === kmsId` (exact
   *      match — a substring hit on a different entry's metadata is a false
   *      positive we must not act on).
   *   3. If exactly one match, call client.update(mem0Id, content).
   *   4. If zero matches → probe-and-skip: log debug, return false. This
   *      mirrors the kms_supersede pattern (PR #65 / issue #62): an entry
   *      may not have been routed to Mem0 (routing is content-type
   *      dependent), and the corrective op should succeed silently rather
   *      than fail the whole update.
   *   5. If multiple matches → log warning, update the first (most-relevant
   *      per Mem0's ranking). Multi-match shouldn't happen in practice
   *      (kms_id is set once per store) but defensive logging surfaces
   *      anomalies.
   *
   * Mem0 v3 SDK update signature is `update(memoryId, message)` — text
   * only, no metadata. Mem0's LLM re-extracts metadata from the new text
   * itself; we cannot directly set kms_id / subject / etc. on update. The
   * kms_id we wrote at store() time persists.
   *
   * Return value mirrors the boolean shape of MongoStorage.update /
   * SparrowDBStorage.update: true on successful propagation, false on any
   * skip / soft-fail / unexpected error. We never throw — Mem0 propagation
   * is best-effort by design (a Mem0 outage must not tear down a kms_update
   * that already mutated Mongo + SparrowDB).
   */
  async update(
    id: string,
    content?: string,
    _metadata?: Record<string, unknown>,
    userId?: string
  ): Promise<boolean> {
    // No content → no-op. Mem0's update endpoint requires `text`. A
    // metadata-only or confidence-only kms_update has no Mem0 equivalent
    // (Mem0 re-extracts metadata from content; there's no direct setter).
    if (content === undefined || content === null || content === '') {
      console.log(`🧠 [Mem0Storage.update] No content provided for ${id} — skipping Mem0 propagation (Mem0 update requires text)`)
      return false
    }

    try {
      const resolvedUserId = userId || this.config.defaultUserId || 'personal'

      // Step 1: locate the Mem0 internal id via search.
      // Use the kms_id as the query string. Mem0 stores metadata fields as
      // part of the indexed payload, so the id usually surfaces in the top
      // few hits. Cap at 50 to bound the client-side filter cost.
      let mem0Id: string | null = null
      try {
        type Mem0SearchResponse = any[] | { results?: any[] }
        // Mirrors Mem0Storage.search() above: declare the options as a free
        // object literal (not typed against SearchOptions) so the SDK's
        // camelCase `topK` — which it converts to snake_case at the wire —
        // is accepted. The SDK's published .d.ts only lists `top_k`; the
        // runtime accepts both.
        const searchOptions = {
          topK: 50,
          filters: { user_id: resolvedUserId }
        }
        const response = await this.client.search(id, searchOptions) as unknown as Mem0SearchResponse
        const results: any[] = Array.isArray(response) ? response : (response?.results ?? [])

        // Step 2: exact-match filter on metadata.kms_id. Substring hits on
        // adjacent entries' metadata would be false positives.
        const matches = results.filter((r: any) => r?.metadata?.kms_id === id)

        if (matches.length === 0) {
          // Probe-and-skip — entry may never have been routed to Mem0
          // (routing is content-type dependent). Same pattern as PR #65.
          console.log(`🧠 [Mem0Storage.update] kms_id=${id} not found in Mem0 for user=${resolvedUserId} — skipping (probe-and-skip)`)
          return false
        }

        if (matches.length > 1) {
          console.warn(`⚠️ [Mem0Storage.update] kms_id=${id} returned ${matches.length} Mem0 matches — using first. This usually means a duplicate kms_id was written to Mem0; investigate.`)
        }

        mem0Id = matches[0].id
        if (!mem0Id) {
          console.warn(`⚠️ [Mem0Storage.update] Mem0 search match for kms_id=${id} has no id field — skipping`)
          return false
        }
      } catch (searchError) {
        // Search failure is non-fatal — log and skip. We don't want a
        // transient Mem0 search error to fail the whole kms_update.
        console.warn(`⚠️ [Mem0Storage.update] Mem0 search failed while looking up kms_id=${id}:`, searchError)
        return false
      }

      // Step 3: call Mem0 update with the resolved internal id.
      try {
        console.log(`🧠 [Mem0Storage.update] Updating Mem0 entry mem0Id=${mem0Id} for kms_id=${id}`)
        await this.client.update(mem0Id, content)
        console.log(`✅ [Mem0Storage.update] Successfully propagated kms_update to Mem0 (kms_id=${id}, mem0Id=${mem0Id})`)
        return true
      } catch (updateError) {
        // 404 = entry was deleted between our search and update (rare
        // race). Treat as probe-and-skip — there's nothing to update,
        // and we don't want to fail the kms_update for a vanished entry.
        const errMsg = updateError instanceof Error ? updateError.message : String(updateError)
        if (/\b404\b|not found|does not exist/i.test(errMsg)) {
          console.log(`🧠 [Mem0Storage.update] Mem0 entry mem0Id=${mem0Id} returned 404 on update — skipping (probe-and-skip)`)
          return false
        }
        // Other errors are unexpected and should bubble up so the unified
        // layer can log them.
        console.error(`❌ [Mem0Storage.update] Unexpected Mem0 update error for kms_id=${id}:`, updateError)
        throw updateError
      }
    } catch (error) {
      // Outer catch for anything that escaped — keep the same defensive
      // shape as the rest of this class so a Mem0 hiccup never tears down
      // a kms_update call.
      console.error(`❌ [Mem0Storage.update] Failed to propagate kms_update to Mem0 for kms_id=${id}:`, error)
      return false
    }
  }

  private generateUserId(knowledge: UnifiedKnowledge): string {
    if (knowledge.userId) {
      return knowledge.userId
    }
    if (knowledge.source === 'personal') {
      return this.config.defaultUserId || 'system_personal'
    }
    return `system_${knowledge.source}`
  }

  private generateUserIdFromQuery(query: KnowledgeQuery): string {
    if (query.filters?.userId) {
      return query.filters.userId
    }

    if (!this.config.defaultUserId) {
      console.warn('⚠️ KMS_DEFAULT_USER_ID not configured, using fallback "personal"')
      return 'personal'
    }

    return this.config.defaultUserId
  }

  private buildMem0Filters(filters?: KnowledgeQuery['filters']): any {
    if (!filters) return {}

    const mem0Filters: any = {}

    if (filters.contentType) {
      mem0Filters.content_type = filters.contentType
    }

    if (filters.source) {
      mem0Filters.source = filters.source
    }

    if (filters.minConfidence) {
      mem0Filters.min_confidence = filters.minConfidence
    }

    // Subject facet (DG-FACET-A). Mem0 stores arbitrary fields under metadata.*
    // when we pass them via options.metadata at store time (see store()), so
    // filtering on `subject` here surfaces only entries with the matching facet.
    if (filters.subject !== undefined) {
      mem0Filters.subject = filters.subject
    }

    return mem0Filters
  }

  private getKnownUserIds(): string[] {
    const defaultUserId = this.config.defaultUserId || 'personal'
    return [defaultUserId, 'system_technical', 'system_global']
  }

  async testDirectSearch(query: string, userId: string = this.config.defaultUserId || 'personal'): Promise<any> {
    try {
      console.log(`🧪 [Mem0Storage.testDirectSearch] Testing direct search for: "${query}" with user: ${userId}`)

      const searchQuery = query
      // v3 SDK contract: user_id inside filters (see Mem0Storage.search above).
      const searchOptions = {
        topK: 10,
        filters: { user_id: userId }
      }

      console.log(`🧪 [Mem0Storage.testDirectSearch] Search query: "${searchQuery}"`)
      console.log(`🧪 [Mem0Storage.testDirectSearch] Search options:`, JSON.stringify(searchOptions, null, 2))

      const response = await this.client.search(searchQuery, searchOptions) as any
      const results = Array.isArray(response) ? response : (response?.results ?? [])
      console.log(`🧪 [Mem0Storage.testDirectSearch] Raw results:`, JSON.stringify(results, null, 2))

      return {
        success: true,
        query,
        userId,
        rawResults: results,
        count: results?.length || 0
      }
    } catch (error) {
      console.error(`🧪 [Mem0Storage.testDirectSearch] Error:`, error)
      return {
        success: false,
        query,
        userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    }
  }

  async close(): Promise<void> {
    // Mem0 is a cloud service, no explicit connection to close
    console.log('🧠 Mem0 client cleaned up')
  }
}
