/**
 * Mem0 Storage System Implementation
 */

// Real Mem0 client interface
interface Mem0Client {
  add(data: any): Promise<any>
  search(query: string, options?: any): Promise<any[]>
  get(data: any): Promise<any[]>
  getById?(id: string): Promise<any>
  delete(id: string): Promise<any>
}

import { StorageSystem, UnifiedKnowledge, KnowledgeQuery, KMSConfig } from '../types/index.js'

export class Mem0Storage implements StorageSystem {
  public name = 'mem0'
  private client!: Mem0Client

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
      }) as any
      
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
      
      // Store in Mem0 with rich metadata
      const memoryData = {
        messages: [{ 
          role: 'user', 
          content: knowledge.content 
        }],
        userId,
        metadata: {
          kms_id: knowledge.id,
          content_type: knowledge.contentType,
          source: knowledge.source,
          confidence: knowledge.confidence,
          coach_id: knowledge.coachId,
          timestamp: knowledge.timestamp.toISOString(),
          ...knowledge.metadata
        }
      }
      
      await this.client.add(memoryData)
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
      const searchOptions = {
        user_id: userId, // Use user_id as expected by Mem0 SDK
        limit: query.options?.maxResults || 10,
        filters: this.buildMem0Filters(query.filters),
        api_version: 'v1'
      }
      
      console.log(`🧠 [Mem0Storage.search] Search query: "${searchQuery}"`)
      console.log(`🧠 [Mem0Storage.search] Search options:`, JSON.stringify(searchOptions, null, 2))
      
      const results = await this.client.search(searchQuery, searchOptions)
      
      const processedResults = results.map(r => ({
        id: r.id || r.metadata?.kms_id,
        content: r.memory || r.text,
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
      // Mem0 doesn't have a direct stats API, so we estimate based on user data
      // In production, you might want to maintain your own stats
      
      return {
        totalMemories: 'estimated', // Mem0 doesn't provide direct count
        status: 'connected',
        userNamespaces: this.getKnownUserIds(),
        features: {
          semanticSearch: true,
          contextualRetrieval: true,
          memoryEvolution: true,
          crossUserSearch: false // Privacy-focused
        },
        apiEndpoint: 'Mem0 Cloud Service'
      }
    } catch (error) {
      console.error('❌ Mem0 stats error:', error)
      return {
        totalMemories: 0,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async getMemoriesForUser(userId: string, limit = 50): Promise<any[]> {
    try {
      const memories = await this.client.get({
        userId,
        limit
      })
      
      return memories.map(m => ({
        id: m.id,
        content: m.memory,
        metadata: m.metadata,
        createdAt: m.created_at,
        updatedAt: m.updated_at
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
      
      // Use the correct TypeScript SDK method - pass memoryId directly as string
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
    // Generate consistent user ID based on knowledge context
    if (knowledge.userId) {
      return knowledge.userId
    }
    
    if (knowledge.coachId) {
      return `coach_${knowledge.coachId}`
    }
    
    if (knowledge.source === 'personal') {
      return this.config.defaultUserId || 'system_personal'
    }
    
    return `system_${knowledge.source}`
  }

  private generateUserIdFromQuery(query: KnowledgeQuery): string {
    // Generate user ID for search context
    if (query.filters?.userId) {
      return query.filters.userId
    }
    
    if (query.filters?.coachId) {
      return `coach_${query.filters.coachId}`
    }
    
    // Use configured default user ID or fall back to system_global
    return this.config.defaultUserId || 'system_global'
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
    
    return mem0Filters
  }

  private getKnownUserIds(): string[] {
    // In production, you might want to track this
    return [
      'richard_yaker',
      'system_coaching',
      'system_technical',
      'system_global'
    ]
  }


  async testDirectSearch(query: string, userId: string = 'richard_yaker'): Promise<any> {
    try {
      console.log(`🧪 [Mem0Storage.testDirectSearch] Testing direct search for: "${query}" with user: ${userId}`)
      
      const searchQuery = query
      const searchOptions = {
        user_id: userId,
        limit: 10,
        api_version: 'v1'
      }
      
      console.log(`🧪 [Mem0Storage.testDirectSearch] Search query: "${searchQuery}"`)
      console.log(`🧪 [Mem0Storage.testDirectSearch] Search options:`, JSON.stringify(searchOptions, null, 2))
      
      const results = await this.client.search(searchQuery, searchOptions)
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
