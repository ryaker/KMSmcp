/**
 * Unified Search Tool - Cross-system search with FACT caching
 */
import { KnowledgeQuery } from '../types/index.js';
import { FACTCache } from '../cache/FACTCache.js';
import { MongoDBStorage, Neo4jStorage, Mem0Storage } from '../storage/index.js';
export declare class UnifiedSearchTool {
    private storage;
    private cache;
    constructor(storage: {
        mongodb: MongoDBStorage;
        neo4j: Neo4jStorage;
        mem0: Mem0Storage;
    }, cache: FACTCache | null);
    /**
     * Search across all KMS systems with intelligent caching
     * This is the main "unified_search" tool function
     */
    search(args: {
        query: string;
        filters?: {
            contentType?: string[];
            source?: string[];
            userId?: string;
            coachId?: string;
            minConfidence?: number;
        };
        options?: {
            includeRelationships?: boolean;
            maxResults?: number;
            cacheStrategy?: 'aggressive' | 'conservative' | 'realtime';
        };
    }): Promise<{
        query: string;
        results: any[];
        totalFound: number;
        searchTime: number;
        fromCache: boolean;
        sources: {
            mem0: number;
            neo4j: number;
            mongodb: number;
        };
        performance: {
            cacheCheckTime: number;
            searchTime: number;
            mergingTime: number;
            totalTime: number;
        };
    }>;
    /**
     * Search specific system
     */
    searchSystem(system: 'mem0' | 'neo4j' | 'mongodb', query: KnowledgeQuery): Promise<any[]>;
    /**
     * Get search recommendations based on query analysis
     */
    getSearchRecommendations(query: string): {
        recommendedSystems: string[];
        suggestedFilters: Record<string, any>;
        reasoning: string;
    };
    private searchMem0;
    private searchNeo4j;
    private searchMongoDB;
    /**
     * Remove duplicate results based on content similarity
     */
    private deduplicateResults;
    /**
     * Rank results by relevance and confidence
     */
    private rankResults;
    /**
     * Calculate content relevance to query
     */
    private calculateRelevance;
    /**
     * Get cache TTL based on strategy
     */
    private getCacheTTL;
}
//# sourceMappingURL=UnifiedSearchTool.d.ts.map