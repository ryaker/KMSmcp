/**
 * Intelligent Storage Router
 * Analyzes knowledge content and determines optimal storage strategy
 */
export class IntelligentStorageRouter {
    rules = [
        // Memory patterns - route to Mem0
        {
            pattern: /memory|remember|recall|client|user.*prefer|behavior|pattern|habit|tendency/i,
            contentTypes: ['memory'],
            primary: 'mem0',
            reasoning: 'Memory and client behavior patterns optimize for Mem0 semantic search and user context'
        },
        // Relationships and insights - route to Neo4j
        {
            pattern: /relationship|connect|technique|effective|insight|concept|framework|methodology|approach|strategy/i,
            contentTypes: ['insight', 'relationship'],
            primary: 'neo4j',
            reasoning: 'Relationships and coaching insights leverage Neo4j graph capabilities for technique effectiveness'
        },
        // Structured data - route to MongoDB
        {
            pattern: /config|setting|schema|session|conversation|metadata|profile|authentication|billing/i,
            contentTypes: ['fact', 'procedure'],
            primary: 'mongodb',
            reasoning: 'Structured configuration and session data suits MongoDB document storage and indexing'
        },
        // Learning patterns - route to Mem0 + Neo4j
        {
            pattern: /learn|breakthrough|discovery|pattern|evolution|improvement|adaptation/i,
            contentTypes: ['pattern'],
            primary: 'mem0',
            reasoning: 'Learning patterns combine memory (Mem0) with relationship tracking (Neo4j)'
        },
        // Technical knowledge - route to MongoDB + Mem0
        {
            pattern: /bug|fix|error|implementation|code|api|endpoint|database|integration/i,
            contentTypes: ['fact', 'procedure'],
            primary: 'mongodb',
            reasoning: 'Technical knowledge needs structured storage (MongoDB) with searchable context (Mem0)'
        }
    ];
    /**
     * Analyze knowledge and determine optimal storage strategy
     */
    determineStorage(knowledge) {
        const content = knowledge.content || '';
        const contentType = knowledge.contentType;
        const source = knowledge.source;
        const userId = knowledge.userId;
        console.log(`🧠 Analyzing storage for: "${content.slice(0, 50)}..."`);
        console.log(`   Content Type: ${contentType}, Source: ${source}, User: ${userId}`);
        // Find matching rule
        const matchingRule = this.findMatchingRule(content, contentType);
        if (matchingRule) {
            const decision = {
                primary: matchingRule.primary,
                secondary: this.getSecondaryStorage(matchingRule.primary, knowledge),
                reasoning: matchingRule.reasoning,
                cacheStrategy: this.determineCacheStrategy(knowledge)
            };
            console.log(`✅ Storage Decision:`);
            console.log(`   Primary: ${decision.primary}`);
            console.log(`   Secondary: ${decision.secondary?.join(', ') || 'none'}`);
            console.log(`   Cache: ${decision.cacheStrategy}`);
            console.log(`   Reasoning: ${decision.reasoning}`);
            return decision;
        }
        // Default fallback strategy
        const decision = {
            primary: 'mongodb',
            secondary: ['mem0'], // Cross-index in Mem0 for searchability
            reasoning: 'Default storage for unclassified content with Mem0 search indexing',
            cacheStrategy: 'L2'
        };
        console.log(`⚠️  Using default storage strategy for unmatched content`);
        return decision;
    }
    /**
     * Find the best matching rule for given content
     */
    findMatchingRule(content, contentType) {
        // First try to match by content type
        if (contentType) {
            const typeMatch = this.rules.find(rule => rule.contentTypes.includes(contentType));
            if (typeMatch) {
                console.log(`📝 Matched by content type: ${contentType}`);
                return typeMatch;
            }
        }
        // Then try to match by content pattern
        const patternMatch = this.rules.find(rule => rule.pattern.test(content));
        if (patternMatch) {
            console.log(`🔍 Matched by pattern: ${patternMatch.pattern}`);
            return patternMatch;
        }
        console.log(`❌ No rule matched for content type "${contentType}" or content pattern`);
        return null;
    }
    /**
     * Determine secondary storage systems for cross-linking
     */
    getSecondaryStorage(primary, knowledge) {
        const secondary = [];
        switch (primary) {
            case 'mem0':
                // Memory in Mem0 → Store metadata in MongoDB for structured queries
                secondary.push('mongodb');
                // If it has relationships, also store in Neo4j
                if (knowledge.relationships && knowledge.relationships.length > 0) {
                    secondary.push('neo4j');
                }
                break;
            case 'neo4j':
                // Insights in Neo4j → Index in Mem0 for semantic search
                secondary.push('mem0');
                // If it's coaching related, store config in MongoDB
                if (knowledge.source === 'coaching' || knowledge.coachId) {
                    secondary.push('mongodb');
                }
                break;
            case 'mongodb':
                // Structured data in MongoDB → Index in Mem0 for search
                secondary.push('mem0');
                // If it describes relationships, also store in Neo4j
                const content = knowledge.content || '';
                if (/relationship|connect|link|associate|relate/i.test(content)) {
                    secondary.push('neo4j');
                }
                break;
        }
        return secondary;
    }
    /**
     * Determine cache strategy based on knowledge characteristics
     */
    determineCacheStrategy(knowledge) {
        // Richard's personal queries - cache aggressively
        if (knowledge.userId === 'richard_yaker') {
            console.log(`🚀 L1 cache for richard_yaker`);
            return 'L1';
        }
        // Coaching insights and client memories - cache moderately
        if (knowledge.contentType === 'memory' || knowledge.source === 'coaching') {
            console.log(`⚡ L2 cache for coaching/memory content`);
            return 'L2';
        }
        // High confidence knowledge - cache moderately
        if (knowledge.confidence && knowledge.confidence > 0.8) {
            console.log(`⚡ L2 cache for high confidence content`);
            return 'L2';
        }
        // Technical knowledge - cache conservatively
        if (knowledge.source === 'technical') {
            console.log(`💾 L3 cache for technical content`);
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
            totalRules: this.rules.length,
            ruleCategories: {
                memory: this.rules.filter(r => r.primary === 'mem0').length,
                insights: this.rules.filter(r => r.primary === 'neo4j').length,
                structured: this.rules.filter(r => r.primary === 'mongodb').length
            },
            contentTypes: {
                memory: this.rules.filter(r => r.contentTypes.includes('memory')).length,
                insight: this.rules.filter(r => r.contentTypes.includes('insight')).length,
                relationship: this.rules.filter(r => r.contentTypes.includes('relationship')).length,
                fact: this.rules.filter(r => r.contentTypes.includes('fact')).length,
                procedure: this.rules.filter(r => r.contentTypes.includes('procedure')).length,
                pattern: this.rules.filter(r => r.contentTypes.includes('pattern')).length
            }
        };
    }
    /**
     * Test routing decision for given content (useful for debugging)
     */
    testRouting(content, contentType) {
        return this.determineStorage({ content, contentType });
    }
    /**
     * Add custom routing rule
     */
    addRule(rule) {
        this.rules.push(rule);
        console.log(`➕ Added custom routing rule for ${rule.primary}: ${rule.pattern}`);
    }
    /**
     * Remove routing rule by pattern
     */
    removeRule(pattern) {
        const initialLength = this.rules.length;
        this.rules = this.rules.filter(rule => rule.pattern.source !== pattern.source);
        const removed = initialLength - this.rules.length;
        if (removed > 0) {
            console.log(`➖ Removed ${removed} routing rule(s)`);
        }
    }
}
//# sourceMappingURL=IntelligentStorageRouter.js.map