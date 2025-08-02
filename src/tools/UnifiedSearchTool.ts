/**
 * Unified Search Tool - Cross-system search with FACT caching
 */

import crypto from 'crypto'
import { KnowledgeQuery } from '../types/index.js'
import { FACTCache } from '../cache/FACTCache.js'
import { MongoDBStorage, Neo4jStorage, Mem0Storage } from '../storage/index.js'

export class UnifiedSearchTool {
  private storage: {
    mongodb: MongoDBStorage
    neo4j: Neo4jStorage
    mem0: Mem0Storage
  }
  private cache: FACTCache

  constructor(
    storage: { mongodb: MongoDBStorage, neo4j: Neo4jStorage, mem0: Mem0Storage },
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
      coachId?: string
      minConfidence?: number
    }
    options?: {
      includeRelationships?: boolean
      maxResults?: number
      cacheStrategy?: 'aggressive' | 'conservative' | 'realtime'
    }
  }): Promise<{
    query: string
    results: any[]
    totalFound: number
    searchTime: number
    fromCache: boolean
    sources: {
      mem0: number
      neo4j: number
      mongodb: number
    }
    performance: {
      cacheCheckTime: number
      searchTime: number
      mergingTime: number
      totalTime: number
    }
  }> {
    const startTime = Date.now()
    
    console.log(`\n🔍 UNIFIED SEARCH Starting...`)
    console.log(`📝 Query: "${args.query}"`)
    console.log(`🎯 Filters: ${JSON.stringify(args.filters || {})}`)
    console.log(`⚙️  Options: ${JSON.stringify(args.options || {})}`)

    const query: KnowledgeQuery = {
      query: args.query,
      filters: args.filters,
      options: {
        includeRelationships: true,
        maxResults: 10,
        cacheStrategy: 'conservative',
        ...args.options
      }
    }

    // Step 1: Check cache first
    const cacheCheckStart = Date.now()
    const cacheKey = this.cache ? FACTCache.generateSearchKey(args.query, args.filters) : ''
    const cached = this.cache ? await this.cache.get<{
      results: any[]
      totalFound: number
      sources: { mem0: number, neo4j: number, mongodb: number }
    }>(cacheKey) : null
    const cacheCheckTime = Date.now() - cacheCheckStart
    
    if (cached && query.options?.cacheStrategy !== 'realtime') {
      console.log(`⚡ CACHE HIT - Returning cached results`)
      
      return {
        query: query.query,
        results: cached.results || [],
        totalFound: cached.totalFound || 0,
        searchTime: Date.now() - startTime,
        fromCache: true,
        sources: cached.sources || { mem0: 0, neo4j: 0, mongodb: 0 },
        performance: {
          cacheCheckTime,
          searchTime: 0,
          mergingTime: 0,
          totalTime: Date.now() - startTime
        }
      }
    }

    console.log(`💾 Cache miss - Searching all systems...`)

    // Step 2: Search across all systems in parallel
    const searchStart = Date.now()
    
    const [mem0Results, neo4jResults, mongoResults] = await Promise.allSettled([
      this.searchMem0(query),
      this.searchNeo4j(query),
      this.searchMongoDB(query)
    ])

    const searchTime = Date.now() - searchStart

    // Step 3: Process and merge results
    const mergingStart = Date.now()

    const processedResults = {
      mem0: mem0Results.status === 'fulfilled' ? mem0Results.value : [],
      neo4j: neo4jResults.status === 'fulfilled' ? neo4jResults.value : [],
      mongodb: mongoResults.status === 'fulfilled' ? mongoResults.value : []
    }

    console.log(`📊 Results found:`)
    console.log(`   Mem0: ${processedResults.mem0.length}`)
    console.log(`   Neo4j: ${processedResults.neo4j.length}`)
    console.log(`   MongoDB: ${processedResults.mongodb.length}`)

    // Merge all results
    const allResults = [
      ...processedResults.mem0.map(r => ({ ...r, sourceSystem: 'mem0' })),
      ...processedResults.neo4j.map(r => ({ ...r, sourceSystem: 'neo4j' })),
      ...processedResults.mongodb.map(r => ({ ...r, sourceSystem: 'mongodb' }))
    ]

    // Remove duplicates (same ID from different systems)
    const uniqueResults = this.deduplicateResults(allResults)

    // Sort by relevance and confidence
    const sortedResults = this.rankResults(uniqueResults, args.query)
      .slice(0, query.options?.maxResults || 10)

    const mergingTime = Date.now() - mergingStart

    const result = {
      query: args.query,
      results: sortedResults,
      totalFound: allResults.length,
      searchTime: Date.now() - startTime,
      fromCache: false,
      sources: {
        mem0: processedResults.mem0.length,
        neo4j: processedResults.neo4j.length,
        mongodb: processedResults.mongodb.length
      },
      performance: {
        cacheCheckTime,
        searchTime,
        mergingTime,
        totalTime: Date.now() - startTime
      }
    }

    // Step 4: Cache the results
    if (this.cache && query.options?.cacheStrategy !== 'realtime') {
      const ttl = this.getCacheTTL(query.options?.cacheStrategy || 'conservative')
      await this.cache.set(cacheKey, result, ttl)
      console.log(`💾 Results cached for ${Math.round(ttl/1000)}s`)
    }

    console.log(`\n✅ UNIFIED SEARCH COMPLETE`)
    console.log(`   Found: ${sortedResults.length} unique results`)
    console.log(`   Total Time: ${result.searchTime}ms`)
    console.log(`   Cache: ${cached ? 'HIT' : 'MISS'}`)

    return result
  }

  /**
   * Search specific system
   */
  async searchSystem(
    system: 'mem0' | 'neo4j' | 'mongodb',
    query: KnowledgeQuery
  ): Promise<any[]> {
    console.log(`🔍 Searching ${system} only...`)
    
    switch (system) {
      case 'mem0':
        return this.searchMem0(query)
      case 'neo4j':
        return this.searchNeo4j(query)
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
      recommendedSystems: ['mem0', 'neo4j', 'mongodb'] as string[],
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
      recommendations.recommendedSystems = ['neo4j', 'mem0']
      recommendations.suggestedFilters.contentType = ['insight', 'relationship']
      recommendations.reasoning = 'Technique and relationship queries leverage Neo4j graph capabilities'
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

  private async searchNeo4j(query: KnowledgeQuery): Promise<any[]> {
    try {
      return await this.storage.neo4j.search(query)
    } catch (error) {
      console.warn('⚠️ Neo4j search failed:', error instanceof Error ? error.message : String(error))
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
  private deduplicateResults(results: any[]): any[] {
    const unique = new Map<string, any>()
    
    for (const result of results) {
      // Use ID if available, otherwise use content hash
      const key = result.id || crypto.createHash('md5').update(result.content).digest('hex')
      
      // Keep the result with highest confidence
      if (!unique.has(key) || (result.confidence > unique.get(key).confidence)) {
        unique.set(key, result)
      }
    }
    
    return Array.from(unique.values())
  }

  /**
   * Rank results by relevance and confidence
   */
  private rankResults(results: any[], query: string): any[] {
    return results.sort((a, b) => {
      // Primary sort by confidence
      const confidenceDiff = (b.confidence || 0) - (a.confidence || 0)
      if (Math.abs(confidenceDiff) > 0.1) {
        return confidenceDiff
      }

      // Secondary sort by content relevance
      const aRelevance = this.calculateRelevance(a.content, query)
      const bRelevance = this.calculateRelevance(b.content, query)
      
      return bRelevance - aRelevance
    })
  }

  /**
   * Calculate content relevance to query
   */
  private calculateRelevance(content: string, query: string): number {
    if (!content || !query) return 0
    
    const contentLower = content.toLowerCase()
    const queryLower = query.toLowerCase()
    const queryTerms = queryLower.split(/\s+/)
    
    let score = 0
    queryTerms.forEach(term => {
      if (contentLower.includes(term)) {
        score += 1
        // Bonus for exact matches
        if (contentLower.includes(queryLower)) {
          score += 0.5
        }
      }
    })

    return score / queryTerms.length
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
