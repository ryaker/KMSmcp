/**
 * Mem0 Storage System Implementation
 *
 * Targets mem0ai SDK v3.x. Key v1 → v3 deltas applied:
 *  - `add`: `user_id` (snake) → `userId` (camel) at top level. Wire still snake — SDK converts.
 *  - `search` / `getAll`: top-level entity params (`user_id`, `userId`, etc.) are REJECTED.
 *    Must pass `filters: { user_id: '...' }` instead. SDK throws if you don't.
 *  - `search`: `limit` → `topK`, `api_version` removed (SDK now hits /v3/memories/search/ unconditionally),
 *    return shape is `{ results: Memory[] }` (wrapped) — was `Memory[]` (unwrapped).
 *  - `get(memoryId)` only takes a string. The 1.x `get({ user_id, limit })` overload
 *    moved to `getAll(options)` returning `PaginatedMemories { count, next, previous, results }`.
 *  - Response keys are converted snake → camel by the SDK (`createdAt`, `updatedAt`, `userId`).
 *  - `enable_graph` is no longer a recognized option (none in this codebase, but flagged).
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

      // Store in Mem0 with rich metadata. v3: top-level entity is `userId` (camelCase).
      const messages = [{
        role: 'user' as const,
        content: knowledge.content
      }]
      const options = {
        userId,
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
      // v3: user_id MUST live inside filters (top-level entity params now rejected by SDK).
      const searchOptions = {
        topK: query.options?.maxResults || 10,
        filters: {
          user_id: userId,
          ...this.buildMem0Filters(query.filters)
        }
      }

      console.log(`🧠 [Mem0Storage.search] Search query: "${searchQuery}"`)
      console.log(`🧠 [Mem0Storage.search] Search options:`, JSON.stringify(searchOptions, null, 2))

      // v3 search returns { results: Memory[] } (wrapped) instead of Memory[].
      const response = await this.client.search(searchQuery, searchOptions)
      const results = response?.results ?? []

      const processedResults = results.map((r: Memory) => ({
        id: r.id || r.metadata?.kms_id,
        content: r.memory,
        confidence: r.score || r.metadata?.confidence || 0.5,
        metadata: r.metadata || {},
        sourceSystem: 'mem0',
        timestamp: r.metadata?.timestamp ? new Date(r.metadata.timestamp) : new Date(),
        contentType: r.metadata?.content_type,
        source: r.metadata?.source,
        userId: r.userId
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
      // v3 SDK: use getAll() with filters.user_id and pageSize=1 to get the count.
      // Avoids the brittle raw fetch to /v1/memories/ that was used in the 1.x days.
      const userId = this.config.defaultUserId || 'personal'
      const page = await this.client.getAll({
        page: 1,
        pageSize: 1,
        filters: { user_id: userId }
      })
      return {
        totalMemories: page?.count ?? 'unknown',
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
      // v3: the 1.x `get({ user_id, limit })` overload moved to `getAll(options)`.
      // user_id must go inside filters; limit becomes pageSize.
      const page = await this.client.getAll({
        pageSize: limit,
        filters: { user_id: userId }
      })

      const memories = page?.results ?? []
      return memories.map((m: Memory) => ({
        id: m.id,
        content: m.memory,
        metadata: m.metadata,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt
      }))
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
      // v3: user_id must live in filters (top-level entity params now rejected).
      const searchOptions = {
        topK: 10,
        filters: { user_id: userId }
      }

      console.log(`🧪 [Mem0Storage.testDirectSearch] Search query: "${searchQuery}"`)
      console.log(`🧪 [Mem0Storage.testDirectSearch] Search options:`, JSON.stringify(searchOptions, null, 2))

      const response = await this.client.search(searchQuery, searchOptions)
      const results = response?.results ?? []
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
