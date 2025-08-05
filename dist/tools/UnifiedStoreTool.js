/**
 * Unified Store Tool - The heart of intelligent storage routing
 */
import crypto from 'crypto';
import { FACTCache } from '../cache/FACTCache.js';
export class UnifiedStoreTool {
    router;
    storage;
    cache;
    constructor(router, storage, cache) {
        this.router = router;
        this.storage = storage;
        this.cache = cache; // Now using real cache
    }
    /**
     * Store knowledge with intelligent routing
     * This is the main "unified_store" tool function
     */
    async store(args) {
        const startTime = Date.now();
        console.log(`\n🚀 UNIFIED STORE Starting...`);
        console.log(`📝 Content: "${args.content.slice(0, 100)}${args.content.length > 100 ? '...' : ''}"`);
        console.log(`🏷️  Type: ${args.contentType}, Source: ${args.source}`);
        console.log(`👤 User: ${args.userId || 'none'}, Coach: ${args.coachId || 'none'}`);
        // Create unified knowledge object
        const knowledge = {
            id: crypto.randomUUID(),
            content: args.content,
            contentType: args.contentType,
            source: args.source,
            userId: args.userId,
            coachId: args.coachId,
            metadata: args.metadata || {},
            timestamp: new Date(),
            confidence: args.confidence || 0.8,
            relationships: args.relationships || []
        };
        // Step 1: Get intelligent storage decision
        const routingStartTime = Date.now();
        const decision = this.router.determineStorage(knowledge);
        const routingTime = Date.now() - routingStartTime;
        console.log(`\n🧠 STORAGE DECISION:`);
        console.log(`   Primary: ${decision.primary}`);
        console.log(`   Secondary: ${decision.secondary?.join(', ') || 'none'}`);
        console.log(`   Cache Strategy: ${decision.cacheStrategy}`);
        console.log(`   Reasoning: ${decision.reasoning}`);
        // Step 2: Store in systems
        const storageStartTime = Date.now();
        try {
            // Store in primary system
            await this.storeInSystem(knowledge, decision.primary);
            // Store in secondary systems (for cross-linking)
            if (decision.secondary && decision.secondary.length > 0) {
                console.log(`\n🔗 Cross-linking to secondary systems...`);
                await Promise.all(decision.secondary.map(async (system) => {
                    try {
                        await this.storeInSystem(knowledge, system);
                        console.log(`✅ Cross-stored in ${system}`);
                    }
                    catch (error) {
                        console.warn(`⚠️ Failed to cross-store in ${system}:`, error instanceof Error ? error.message : String(error));
                    }
                }));
            }
            const storageTime = Date.now() - storageStartTime;
            // Step 3: Cache based on strategy
            let cached = false;
            if (decision.cacheStrategy !== 'skip') {
                const cacheKey = FACTCache.generateKnowledgeKey(knowledge.userId, knowledge.coachId, knowledge.contentType, { id: knowledge.id });
                if (this.cache) {
                    const ttl = this.getCacheTTL(decision.cacheStrategy);
                    await this.cache.set(cacheKey, knowledge, ttl);
                    cached = true;
                    console.log(`💾 Cached with ${decision.cacheStrategy} strategy (TTL: ${Math.round(ttl / 1000)}s)`);
                }
            }
            const totalTime = Date.now() - startTime;
            console.log(`\n✅ UNIFIED STORE COMPLETE`);
            console.log(`   ID: ${knowledge.id}`);
            console.log(`   Total Time: ${totalTime}ms`);
            console.log(`   Systems: ${[decision.primary, ...(decision.secondary || [])].join(', ')}`);
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
            };
        }
        catch (error) {
            console.error(`❌ UNIFIED STORE FAILED:`, error);
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
            };
        }
    }
    /**
     * Store knowledge in a specific system
     */
    async storeInSystem(knowledge, system) {
        console.log(`📊 Storing in ${system}...`);
        switch (system) {
            case 'mem0':
                await this.storage.mem0.store(knowledge);
                break;
            case 'neo4j':
                await this.storage.neo4j.store(knowledge);
                break;
            case 'mongodb':
                await this.storage.mongodb.store(knowledge);
                break;
            default:
                throw new Error(`Unknown storage system: ${system}`);
        }
        console.log(`✅ Successfully stored in ${system}`);
    }
    /**
     * Get cache TTL based on strategy
     */
    getCacheTTL(strategy) {
        switch (strategy) {
            case 'L1': return 300000; // 5 minutes - aggressive caching
            case 'L2': return 1800000; // 30 minutes - moderate caching
            case 'L3': return 3600000; // 1 hour - conservative caching
            default: return 1800000; // Default to L2
        }
    }
    /**
     * Get storage recommendation without storing
     * This supports the "get_storage_recommendation" tool
     */
    getStorageRecommendation(args) {
        console.log(`\n🤔 STORAGE RECOMMENDATION REQUEST`);
        console.log(`📝 Content: "${args.content.slice(0, 100)}..."`);
        console.log(`🏷️  Type: ${args.contentType || 'auto-detect'}`);
        const decision = this.router.determineStorage({
            content: args.content,
            contentType: args.contentType,
            metadata: args.metadata
        });
        console.log(`\n💡 RECOMMENDATION:`);
        console.log(`   Primary: ${decision.primary}`);
        console.log(`   Secondary: ${decision.secondary?.join(', ') || 'none'}`);
        console.log(`   Cache: ${decision.cacheStrategy}`);
        console.log(`   Why: ${decision.reasoning}`);
        return decision;
    }
    /**
     * Test the routing logic with sample data
     */
    async testRouting() {
        console.log(`\n🧪 TESTING ROUTING LOGIC`);
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
        ];
        const results = testCases.map(test => {
            const decision = this.router.determineStorage({
                content: test.content,
                contentType: test.contentType
            });
            console.log(`\n📝 "${test.content.slice(0, 50)}..."`);
            console.log(`   Type: ${test.contentType} → ${decision.primary}`);
            console.log(`   Reasoning: ${decision.reasoning}`);
            return {
                content: test.content,
                contentType: test.contentType,
                decision
            };
        });
        return { tests: results };
    }
    /**
     * Get routing statistics
     */
    getRoutingStats() {
        return this.router.getRoutingStats();
    }
}
