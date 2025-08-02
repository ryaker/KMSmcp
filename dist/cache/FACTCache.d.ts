/**
 * FACT Cache Implementation - 3-Layer Caching System
 * L1: In-memory (fastest, limited size)
 * L2: Redis (fast, shared across instances)
 * L3: Database queries (slowest, but always available)
 */
import Redis from 'ioredis';
import { FACTCacheLayer, KMSConfig } from '../types/index.js';
export declare class FACTCache implements FACTCacheLayer {
    private config;
    private l1Cache;
    private redis;
    private stats;
    constructor(config: KMSConfig['fact'], redisClient: Redis);
    /**
     * Get value from cache (tries L1 → L2 → L3)
     */
    get<T>(key: string): Promise<T | null>;
    /**
     * Set value in cache with automatic layer management
     */
    set<T>(key: string, value: T, ttl?: number): Promise<void>;
    /**
     * Invalidate cache entries matching pattern
     */
    invalidate(pattern: string): Promise<void>;
    /**
     * Get cache performance statistics
     */
    getStats(): Promise<Record<string, any>>;
    /**
     * Clean up expired L1 cache entries
     */
    private cleanupL1;
    /**
     * Calculate performance speedup from caching
     */
    private calculateSpeedup;
    /**
     * Generate cache key for knowledge
     */
    static generateKnowledgeKey(userId?: string, coachId?: string, type?: string, context?: any): string;
    /**
     * Generate cache key for search queries
     */
    static generateSearchKey(query: string, filters?: any): string;
}
//# sourceMappingURL=FACTCache.d.ts.map