/**
 * FACT Cache Implementation - 3-Layer Caching System
 * L1: In-memory (fastest, limited size)
 * L2: Redis (fast, shared across instances)
 * L3: Database queries (slowest, but always available)
 */

import Redis from 'ioredis'
import { FACTCacheLayer, KMSConfig } from '../types/index.js'

export class FACTCache implements FACTCacheLayer {
  private l1Cache = new Map<string, { value: any, expires: number }>()
  private redis: Redis
  private stats = {
    l1Hits: 0, l1Misses: 0,
    l2Hits: 0, l2Misses: 0,
    l3Hits: 0, l3Misses: 0
  }

  constructor(private config: KMSConfig['fact'], redisClient: Redis) {
    this.redis = redisClient
    
    // L1 Cache cleanup interval (every minute)
    setInterval(() => this.cleanupL1(), 60000)
    
    console.log(`🚀 FACT Cache initialized:`)
    console.log(`  L1 Cache: ${Math.round(config.l1CacheSize / 1024 / 1024)}MB`)
    console.log(`  L2 TTL: ${Math.round(config.l2CacheTTL / 1000 / 60)}min`)
    console.log(`  L3 TTL: ${Math.round(config.l3CacheTTL / 1000 / 60)}min`)
  }

  /**
   * Get value from cache (tries L1 → L2 → L3)
   */
  async get<T>(key: string): Promise<T | null> {
    // L1 Cache (Memory) - Sub-millisecond access
    const l1Entry = this.l1Cache.get(key)
    if (l1Entry && l1Entry.expires > Date.now()) {
      this.stats.l1Hits++
      console.log(`⚡ L1 Cache HIT: ${key}`)
      return l1Entry.value as T
    }
    this.stats.l1Misses++

    // L2 Cache (Redis) - ~1-5ms access (fallback gracefully if unavailable)
    if (this.redis.status === 'ready') {
      try {
        const l2Value = await this.redis.get(key)
        if (l2Value) {
          this.stats.l2Hits++
          console.log(`🚀 L2 Cache HIT: ${key}`)
          const parsed = JSON.parse(l2Value) as T
          
          // Promote to L1 for future access
          this.l1Cache.set(key, {
            value: parsed,
            expires: Date.now() + 300000 // 5 minutes in L1
          })
          
          return parsed
        }
      } catch (error) {
        console.warn('⚠️  L2 cache read failed, continuing without cache:', error instanceof Error ? error.message : String(error))
      }
    }
    this.stats.l2Misses++

    // L3 Cache miss - caller will query database
    this.stats.l3Misses++
    console.log(`💾 Cache MISS: ${key} - will query database`)
    return null
  }

  /**
   * Set value in cache with automatic layer management
   */
  async set<T>(key: string, value: T, ttl = this.config.l2CacheTTL): Promise<void> {
    // Set in L1 (memory) with shorter TTL
    const l1TTL = Math.min(ttl, 300000) // Max 5 minutes for L1
    this.l1Cache.set(key, {
      value,
      expires: Date.now() + l1TTL
    })

    // Set in L2 (Redis) with full TTL (fallback gracefully if unavailable)
    if (this.redis.status === 'ready') {
      try {
        await this.redis.setex(key, Math.floor(ttl / 1000), JSON.stringify(value))
        console.log(`📝 Cached: ${key} (L1: ${Math.round(l1TTL/1000)}s, L2: ${Math.round(ttl/1000)}s)`)
      } catch (error) {
        console.warn('⚠️  L2 cache write failed, using L1 only:', error instanceof Error ? error.message : String(error))
        console.log(`📝 Cached: ${key} (L1: ${Math.round(l1TTL/1000)}s, L2: unavailable)`)
      }
    } else {
      console.log(`📝 Cached: ${key} (L1: ${Math.round(l1TTL/1000)}s, L2: disconnected)`)
    }
  }

  /**
   * Invalidate cache entries matching pattern
   */
  async invalidate(pattern: string): Promise<void> {
    let invalidated = 0

    // Invalidate L1 (memory)
    const keys = Array.from(this.l1Cache.keys())
    keys.forEach(key => {
      if (key.includes(pattern)) {
        this.l1Cache.delete(key)
        invalidated++
      }
    })

    // Invalidate L2 (Redis) - skip if unavailable
    if (this.redis.status === 'ready') {
      try {
        const redisKeys = await this.redis.keys(`*${pattern}*`)
        if (redisKeys.length > 0) {
          await this.redis.del(...redisKeys)
          invalidated += redisKeys.length
        }
      } catch (error) {
        console.warn('⚠️  L2 cache invalidation failed, L1 cleared:', error instanceof Error ? error.message : String(error))
      }
    }

    console.log(`🗑️  Invalidated ${invalidated} cache entries matching: ${pattern}`)
  }

  /**
   * Get cache performance statistics
   */
  async getStats(): Promise<Record<string, any>> {
    const l1Size = this.l1Cache.size
    const totalL1 = this.stats.l1Hits + this.stats.l1Misses
    const totalL2 = this.stats.l2Hits + this.stats.l2Misses
    
    const stats = {
      l1: {
        size: l1Size,
        hitRate: totalL1 > 0 ? this.stats.l1Hits / totalL1 : 0,
        hits: this.stats.l1Hits,
        misses: this.stats.l1Misses,
        avgAccessTime: '< 1ms'
      },
      l2: {
        connected: this.redis.status === 'ready',
        hitRate: totalL2 > 0 ? this.stats.l2Hits / totalL2 : 0,
        hits: this.stats.l2Hits,
        misses: this.stats.l2Misses,
        avgAccessTime: '1-5ms'
      },
      l3: {
        misses: this.stats.l3Misses,
        avgAccessTime: '50-200ms'
      },
      overall: {
        totalQueries: totalL1,
        cacheEfficiency: totalL1 > 0 ? (this.stats.l1Hits + this.stats.l2Hits) / totalL1 : 0,
        estimatedSpeedup: this.calculateSpeedup()
      }
    }

    return stats
  }

  /**
   * Clean up expired L1 cache entries
   */
  private cleanupL1(): void {
    const now = Date.now()
    let cleaned = 0
    
    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.expires <= now) {
        this.l1Cache.delete(key)
        cleaned++
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 L1 Cache cleanup: removed ${cleaned} expired entries`)
    }
  }

  /**
   * Calculate performance speedup from caching
   */
  private calculateSpeedup(): string {
    const totalQueries = this.stats.l1Hits + this.stats.l1Misses
    if (totalQueries === 0) return '0x'
    
    const cacheHits = this.stats.l1Hits + this.stats.l2Hits
    const cacheEfficiency = cacheHits / totalQueries
    
    // Estimate speedup based on cache efficiency
    // L1 hits: ~100x faster than DB
    // L2 hits: ~20x faster than DB
    const l1Speedup = (this.stats.l1Hits / totalQueries) * 100
    const l2Speedup = (this.stats.l2Hits / totalQueries) * 20
    const totalSpeedup = l1Speedup + l2Speedup
    
    return `${totalSpeedup.toFixed(1)}x`
  }

  /**
   * Generate cache key for knowledge
   */
  static generateKnowledgeKey(userId?: string, coachId?: string, type?: string, context?: any): string {
    const parts = ['knowledge']
    if (userId) parts.push(`user:${userId}`)
    if (coachId) parts.push(`coach:${coachId}`)
    if (type) parts.push(`type:${type}`)
    if (context) parts.push(`ctx:${JSON.stringify(context).slice(0, 50)}`)
    
    return parts.join(':')
  }

  /**
   * Generate cache key for search queries
   */
  static generateSearchKey(query: string, filters?: any): string {
    const queryHash = Buffer.from(query).toString('base64').slice(0, 20)
    const filterHash = filters ? Buffer.from(JSON.stringify(filters)).toString('base64').slice(0, 10) : ''
    
    return `search:${queryHash}:${filterHash}`
  }
}
