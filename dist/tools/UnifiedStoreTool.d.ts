/**
 * Unified Store Tool - The heart of intelligent storage routing
 */
import { StorageDecision } from '../types/index.js';
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js';
import { FACTCache } from '../cache/FACTCache.js';
import { MongoDBStorage, Neo4jStorage, Mem0Storage } from '../storage/index.js';
export declare class UnifiedStoreTool {
    private router;
    private storage;
    private cache;
    constructor(router: IntelligentStorageRouter, storage: {
        mongodb: MongoDBStorage;
        neo4j: Neo4jStorage;
        mem0: Mem0Storage;
    }, cache: FACTCache | null);
    /**
     * Store knowledge with intelligent routing
     * This is the main "unified_store" tool function
     */
    store(args: {
        content: string;
        contentType: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure';
        source: 'coaching' | 'personal' | 'technical' | 'cross_domain';
        userId?: string;
        coachId?: string;
        metadata?: Record<string, any>;
        confidence?: number;
        relationships?: Array<{
            targetId: string;
            type: string;
            strength: number;
        }>;
    }): Promise<{
        success: boolean;
        id: string;
        storageDecision: StorageDecision;
        cached: boolean;
        performance: {
            routingTime: number;
            storageTime: number;
            totalTime: number;
        };
    }>;
    /**
     * Store knowledge in a specific system
     */
    private storeInSystem;
    /**
     * Get cache TTL based on strategy
     */
    private getCacheTTL;
    /**
     * Get storage recommendation without storing
     * This supports the "get_storage_recommendation" tool
     */
    getStorageRecommendation(args: {
        content: string;
        contentType?: string;
        metadata?: Record<string, any>;
    }): StorageDecision;
    /**
     * Test the routing logic with sample data
     */
    testRouting(): Promise<{
        tests: Array<{
            content: string;
            contentType: string;
            decision: StorageDecision;
        }>;
    }>;
    /**
     * Get routing statistics
     */
    getRoutingStats(): Record<string, any>;
}
//# sourceMappingURL=UnifiedStoreTool.d.ts.map