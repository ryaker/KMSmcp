/**
 * Unified Search Tool - Cross-system search with FACT caching
 */
import crypto from 'crypto';
import { FACTCache } from '../cache/FACTCache.js';
export class UnifiedSearchTool {
    storage;
    cache;
    constructor(storage, cache) {
        this.storage = storage;
        this.cache = cache; // Now using real cache
    }
    /**
     * Search across all KMS systems with intelligent caching
     * This is the main "unified_search" tool function
     */
    async search(args) {
        const startTime = Date.now();
        console.log(`\n🔍 UNIFIED SEARCH Starting...`);
        console.log(`📝 Query: "${args.query}"`);
        console.log(`🎯 Filters: ${JSON.stringify(args.filters || {})}`);
        console.log(`⚙️  Options: ${JSON.stringify(args.options || {})}`);
        const defaultUserId = process.env.KMS_DEFAULT_USER_ID || 'personal';
        const enforceUserId = (filters) => {
            if (!filters)
                return { userId: defaultUserId };
            return { ...filters, userId: filters.userId || defaultUserId };
        };
        const query = {
            query: args.query,
            filters: enforceUserId(args.filters),
            options: {
                includeRelationships: true,
                maxResults: 10,
                cacheStrategy: 'conservative',
                ...args.options
            }
        };
        // Step 1: Check cache first
        const cacheCheckStart = Date.now();
        const cacheKey = this.cache ? FACTCache.generateSearchKey(args.query, args.filters) : '';
        const cached = this.cache ? await this.cache.get(cacheKey) : null;
        const cacheCheckTime = Date.now() - cacheCheckStart;
        if (cached && query.options?.cacheStrategy !== 'realtime') {
            console.log(`⚡ CACHE HIT - Returning cached results`);
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
            };
        }
        console.log(`💾 Cache miss - Searching all systems...`);
        // Step 2: Search across all systems in parallel
        const searchStart = Date.now();
        const [mem0Results, neo4jResults, mongoResults] = await Promise.allSettled([
            this.searchMem0(query),
            this.searchNeo4j(query),
            this.searchMongoDB(query)
        ]);
        const searchTime = Date.now() - searchStart;
        // Step 3: Process and merge results
        const mergingStart = Date.now();
        const processedResults = {
            mem0: mem0Results.status === 'fulfilled' ? mem0Results.value : [],
            neo4j: neo4jResults.status === 'fulfilled' ? neo4jResults.value : [],
            mongodb: mongoResults.status === 'fulfilled' ? mongoResults.value : []
        };
        console.log(`📊 Results found:`);
        console.log(`   Mem0: ${processedResults.mem0.length}`);
        console.log(`   Neo4j: ${processedResults.neo4j.length}`);
        console.log(`   MongoDB: ${processedResults.mongodb.length}`);
        // Merge all results
        const allResults = [
            ...processedResults.mem0.map(r => ({ ...r, sourceSystem: 'mem0' })),
            ...processedResults.neo4j.map(r => ({ ...r, sourceSystem: 'neo4j' })),
            ...processedResults.mongodb.map(r => ({ ...r, sourceSystem: 'mongodb' }))
        ];
        // Remove duplicates (same ID from different systems)
        const uniqueResults = this.deduplicateResults(allResults);
        // Sort by relevance and confidence
        const sortedResults = this.rankResults(uniqueResults, args.query)
            .slice(0, query.options?.maxResults || 10);
        const mergingTime = Date.now() - mergingStart;
        // Step 4: Context expansion — entity cards + triggered actions
        // Runs AFTER merging so we know which entities surfaced before deciding what to expand.
        const { entity_context, triggered_actions } = await this.expandWithEntityContext(processedResults, args.query);
        // Annotate sortedResults (the actual returned set) with linkedEntityIds from entity_context.
        // expandWithEntityContext annotates processedResults items which are separate spread copies,
        // so we re-apply the annotation here on the objects that callers actually receive.
        for (const r of sortedResults) {
            const linkedIds = [];
            if (r.id && entity_context[r.id])
                linkedIds.push(r.id);
            const refs = r.metadata?.entityRefs || [];
            for (const ref of refs) {
                if (entity_context[ref])
                    linkedIds.push(ref);
            }
            if (linkedIds.length > 0)
                r.linkedEntityIds = linkedIds;
        }
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
            },
            entity_context,
            triggered_actions
        };
        // Step 5: Cache the results
        if (this.cache && query.options?.cacheStrategy !== 'realtime') {
            const ttl = this.getCacheTTL(query.options?.cacheStrategy || 'conservative');
            await this.cache.set(cacheKey, result, ttl);
            console.log(`💾 Results cached for ${Math.round(ttl / 1000)}s`);
        }
        console.log(`\n✅ UNIFIED SEARCH COMPLETE`);
        console.log(`   Found: ${sortedResults.length} unique results`);
        console.log(`   Entities: ${Object.keys(entity_context).length}`);
        console.log(`   Triggered: ${triggered_actions.length}`);
        console.log(`   Total Time: ${result.searchTime}ms`);
        return result;
    }
    /**
     * Context expansion pass — runs after initial search.
     *
     * 1. Collects entity IDs from Neo4j results (Person/Organization/Project nodes)
     * 2. Collects entityRefs from MongoDB result metadata (explicit cross-links)
     * 3. Fetches brief entity summaries for all collected IDs (parallel)
     * 4. Matches ContextTrigger/ToolRoute nodes against query keywords
     *
     * Returns entity_context (brief cards keyed by ID) and triggered_actions.
     */
    async expandWithEntityContext(results, query) {
        // Node types that warrant an entity card — operational/system nodes are returned as triggers instead
        const ENTITY_LABELS = new Set(['Person', 'Organization', 'Project', 'Technology', 'Concept', 'Service', 'Event']);
        const OPERATIONAL_LABELS = new Set(['ContextTrigger', 'ToolRoute', 'ResourceMap', 'QueryType', 'System', 'MemoryTier']);
        // Collect entity IDs from Neo4j results
        const entityIds = new Set();
        for (const r of results.neo4j) {
            const labels = r.nodeLabels || [];
            const hasEntityLabel = labels.some(l => ENTITY_LABELS.has(l));
            const hasOperationalLabel = labels.some(l => OPERATIONAL_LABELS.has(l));
            if (hasEntityLabel && !hasOperationalLabel && r.id) {
                entityIds.add(r.id);
            }
        }
        // Collect entityRefs from MongoDB results — these are explicit cross-links stored with procedures/lessons
        for (const r of results.mongodb) {
            const refs = r.metadata?.entityRefs || [];
            for (const ref of refs)
                entityIds.add(ref);
        }
        // Collect entityRefs from Mem0 results too
        for (const r of results.mem0) {
            const refs = r.metadata?.entityRefs || [];
            for (const ref of refs)
                entityIds.add(ref);
        }
        // Fetch entity summaries in parallel (cap at 6 to avoid slowdown)
        const idsToFetch = Array.from(entityIds).slice(0, 6);
        const entity_context = {};
        if (idsToFetch.length > 0) {
            const summaries = await Promise.allSettled(idsToFetch.map(id => this.storage.neo4j.getEntitySummary(id)));
            for (let i = 0; i < idsToFetch.length; i++) {
                const s = summaries[i];
                if (s.status === 'fulfilled' && s.value) {
                    entity_context[idsToFetch[i]] = s.value;
                }
            }
        }
        // Annotate each result with which entity IDs it links to (for agent consumption)
        for (const r of [...results.neo4j, ...results.mongodb, ...results.mem0]) {
            const linkedIds = [];
            if (r.id && entity_context[r.id])
                linkedIds.push(r.id);
            const refs = r.metadata?.entityRefs || [];
            for (const ref of refs) {
                if (entity_context[ref])
                    linkedIds.push(ref);
            }
            if (linkedIds.length > 0)
                r.linkedEntityIds = linkedIds;
        }
        // Match ContextTrigger/ToolRoute nodes against query keywords
        const triggered_actions = [];
        try {
            const operationalNodes = await this.storage.neo4j.getOperationalNodes();
            const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            for (const node of operationalNodes) {
                const haystack = `${node.name} ${node.description} ${node.taskPattern || ''}`.toLowerCase();
                const matches = queryWords.some(word => haystack.includes(word));
                if (matches) {
                    triggered_actions.push({
                        id: node.id,
                        type: node.type,
                        name: node.name,
                        actions: node.actions
                    });
                }
            }
        }
        catch (error) {
            console.warn('⚠️ Context trigger matching failed:', error);
        }
        return { entity_context, triggered_actions };
    }
    /**
     * Search specific system
     */
    async searchSystem(system, query) {
        console.log(`🔍 Searching ${system} only...`);
        switch (system) {
            case 'mem0':
                return this.searchMem0(query);
            case 'neo4j':
                return this.searchNeo4j(query);
            case 'mongodb':
                return this.searchMongoDB(query);
            default:
                throw new Error(`Unknown system: ${system}`);
        }
    }
    /**
     * Get search recommendations based on query analysis
     */
    getSearchRecommendations(query) {
        const recommendations = {
            recommendedSystems: ['mem0', 'neo4j', 'mongodb'],
            suggestedFilters: {},
            reasoning: 'Search all systems for comprehensive results'
        };
        // Analyze query to make recommendations
        const lowerQuery = query.toLowerCase();
        if (lowerQuery.includes('memory') || lowerQuery.includes('client') || lowerQuery.includes('behavior')) {
            recommendations.recommendedSystems = ['mem0', 'mongodb'];
            recommendations.suggestedFilters.contentType = ['memory'];
            recommendations.reasoning = 'Memory and client-related queries work best with Mem0 and MongoDB';
        }
        else if (lowerQuery.includes('technique') || lowerQuery.includes('relationship') || lowerQuery.includes('effective')) {
            recommendations.recommendedSystems = ['neo4j', 'mem0'];
            recommendations.suggestedFilters.contentType = ['insight', 'relationship'];
            recommendations.reasoning = 'Technique and relationship queries leverage Neo4j graph capabilities';
        }
        else if (lowerQuery.includes('config') || lowerQuery.includes('session') || lowerQuery.includes('setting')) {
            recommendations.recommendedSystems = ['mongodb', 'mem0'];
            recommendations.suggestedFilters.contentType = ['fact', 'procedure'];
            recommendations.reasoning = 'Configuration and session data is best found in MongoDB with Mem0 indexing';
        }
        return recommendations;
    }
    // Private search methods for each system
    async searchMem0(query) {
        try {
            return await this.storage.mem0.search(query);
        }
        catch (error) {
            console.warn('⚠️ Mem0 search failed:', error instanceof Error ? error.message : String(error));
            return [];
        }
    }
    async searchNeo4j(query) {
        try {
            return await this.storage.neo4j.search(query);
        }
        catch (error) {
            console.warn('⚠️ Neo4j search failed:', error instanceof Error ? error.message : String(error));
            return [];
        }
    }
    async searchMongoDB(query) {
        try {
            return await this.storage.mongodb.search(query);
        }
        catch (error) {
            console.warn('⚠️ MongoDB search failed:', error instanceof Error ? error.message : String(error));
            return [];
        }
    }
    /**
     * Remove duplicate results based on content similarity
     */
    deduplicateResults(results) {
        const unique = new Map();
        for (const result of results) {
            // Use ID if available, otherwise use content hash
            const key = result.id || crypto.createHash('md5').update(result.content).digest('hex');
            // Keep the result with highest confidence
            if (!unique.has(key) || (result.confidence > unique.get(key).confidence)) {
                unique.set(key, result);
            }
        }
        return Array.from(unique.values());
    }
    /**
     * Rank results by relevance and confidence
     */
    rankResults(results, query) {
        return results.sort((a, b) => {
            // Primary sort by confidence
            const confidenceDiff = (b.confidence || 0) - (a.confidence || 0);
            if (Math.abs(confidenceDiff) > 0.1) {
                return confidenceDiff;
            }
            // Secondary sort by content relevance
            const aRelevance = this.calculateRelevance(a.content, query);
            const bRelevance = this.calculateRelevance(b.content, query);
            return bRelevance - aRelevance;
        });
    }
    /**
     * Calculate content relevance to query
     */
    calculateRelevance(content, query) {
        if (!content || !query)
            return 0;
        const contentLower = content.toLowerCase();
        const queryLower = query.toLowerCase();
        const queryTerms = queryLower.split(/\s+/);
        let score = 0;
        queryTerms.forEach(term => {
            if (contentLower.includes(term)) {
                score += 1;
                // Bonus for exact matches
                if (contentLower.includes(queryLower)) {
                    score += 0.5;
                }
            }
        });
        return score / queryTerms.length;
    }
    /**
     * Get cache TTL based on strategy
     */
    getCacheTTL(strategy) {
        switch (strategy) {
            case 'aggressive': return 3600000; // 1 hour
            case 'conservative': return 1800000; // 30 minutes  
            case 'realtime': return 0; // No caching
            default: return 1800000;
        }
    }
}
