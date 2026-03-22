/**
 * Intelligent Storage Router
 * Neo4j + Mem0 always (knowledge graph + semantic layer).
 * MongoDB added only for structured/procedural/technical content.
 */
// Pattern that signals content needs MongoDB structured storage in addition to the baseline
const MONGODB_PATTERN = /config|configuration|setting|schema|setup|installation|procedure|step.*by.*step|documentation|specification|authentication|API|endpoint|database|server|deployment|build|compile|debug|error.*log|stack.*trace/i;
export class IntelligentStorageRouter {
    /**
     * Analyze knowledge and determine optimal storage strategy.
     *
     * Architecture:
     *   primary  = neo4j   (knowledge graph — every fact becomes entities + edges)
     *   secondary[0] = mem0  (semantic layer — always present for episodic/semantic recall)
     *   secondary[1] = mongodb  (opt-in — only for procedural/technical/structured content)
     */
    determineStorage(knowledge) {
        const content = knowledge.content || '';
        const contentType = knowledge.contentType;
        const source = knowledge.source;
        console.log(`🧠 Analyzing storage for: "${content.slice(0, 50)}..."`);
        console.log(`   Content Type: ${contentType}, Source: ${source}`);
        const addMongoDB = this.needsStructuredStorage(content, contentType, source);
        const secondary = ['mem0'];
        if (addMongoDB)
            secondary.push('mongodb');
        const reasoning = addMongoDB
            ? 'Neo4j (knowledge graph) + Mem0 (semantic layer) + MongoDB (structured content)'
            : 'Neo4j (knowledge graph) + Mem0 (semantic layer)';
        const decision = {
            primary: 'neo4j',
            secondary,
            reasoning,
            cacheStrategy: this.determineCacheStrategy(knowledge)
        };
        console.log(`✅ Storage Decision:`);
        console.log(`   Primary: ${decision.primary}`);
        console.log(`   Secondary: ${decision.secondary?.join(', ')}`);
        console.log(`   Cache: ${decision.cacheStrategy}`);
        console.log(`   Reasoning: ${decision.reasoning}`);
        return decision;
    }
    /**
     * Determine whether MongoDB structured storage should be added alongside the baseline.
     */
    needsStructuredStorage(content, contentType, source) {
        if (contentType === 'procedure')
            return true;
        if (source === 'technical')
            return true;
        if (MONGODB_PATTERN.test(content))
            return true;
        return false;
    }
    /**
     * Determine cache strategy based on knowledge characteristics
     */
    determineCacheStrategy(knowledge) {
        // Personal user queries - cache aggressively
        if (knowledge.source === 'personal') {
            console.log(`🚀 L1 cache for personal user content`);
            return 'L1';
        }
        // Personal memories and insights - cache moderately
        if (knowledge.contentType === 'memory' || knowledge.contentType === 'insight') {
            console.log(`⚡ L2 cache for personal memory/insight content`);
            return 'L2';
        }
        // High confidence knowledge - cache moderately
        if (knowledge.confidence && knowledge.confidence > 0.8) {
            console.log(`⚡ L2 cache for high confidence content`);
            return 'L2';
        }
        // Technical knowledge - cache conservatively
        if (knowledge.source === 'technical' || knowledge.contentType === 'procedure') {
            console.log(`💾 L3 cache for technical/procedural content`);
            return 'L3';
        }
        // Everything else - conservative caching
        console.log(`💾 L3 cache for general content`);
        return 'L3';
    }
    /**
     * Get routing statistics for analytics
     */
    getRoutingStats() {
        return {
            architecture: 'neo4j+mem0 always, mongodb additive',
            baseline: ['neo4j', 'mem0'],
            mongodbTriggers: ['contentType=procedure', 'source=technical', 'MONGODB_PATTERN match']
        };
    }
    /**
     * Test routing decision for given content (useful for debugging)
     */
    testRouting(content, contentType) {
        return this.determineStorage({ content, contentType });
    }
}
