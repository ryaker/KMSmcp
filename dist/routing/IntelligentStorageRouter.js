/**
 * Intelligent Storage Router
 * Analyzes knowledge content and determines optimal storage strategy
 */
export class IntelligentStorageRouter {
    rules = [
        // Personal experiences, preferences, and interests - route to Mem0
        {
            pattern: /I like|I prefer|I enjoy|I love|I hate|I dislike|my favorite|personal|preference|interest|hobby|learned about|discovered|remember|recall|experience|behavior|habit|tendency|song|music|movie|book|food|travel|family|friend/i,
            contentTypes: ['memory'],
            primary: 'mem0',
            reasoning: 'Personal experiences, preferences, and interests are semantic memories best stored in Mem0 for contextual recall'
        },
        // Career and professional life facts - Mem0 for recall, Neo4j for entity graph (person → company → outcome)
        {
            pattern: /interview|job|position|role|career|hired|rejected|offer|salary|company|worked at|applied|joined|left|promoted|fired|laid off|startup|founded|internship|contract|freelance|consulting|employment|resignation|promotion/i,
            contentTypes: ['fact', 'memory'],
            primary: 'mem0',
            dualPrimary: ['mem0', 'neo4j'],
            reasoning: 'Career facts belong in Mem0 for recall and Neo4j for relationship graph (person → company → outcome)'
        },
        // Relationships between concepts, people, ideas - route to Neo4j
        {
            pattern: /relationship|connect|link|relate|associate|influence|cause|effect|network|similar to|different from|reminds me of|connection between|concept|framework|methodology|approach|strategy|technique|effective/i,
            contentTypes: ['insight', 'relationship'],
            primary: 'neo4j',
            reasoning: 'Conceptual relationships and connections leverage Neo4j graph capabilities for exploring knowledge networks'
        },
        // System configuration, technical procedures, structured data - route to MongoDB
        {
            pattern: /config|configuration|setting|schema|setup|installation|procedure|step.*by.*step|documentation|specification|authentication|API|database|server|deployment|build|compile/i,
            contentTypes: ['fact', 'procedure'],
            primary: 'mongodb',
            reasoning: 'Technical procedures and system configurations need structured storage with precise querying capabilities'
        },
        // Learning patterns and personal growth - route to Mem0 with Neo4j secondary
        {
            pattern: /learn|learning|understand|breakthrough|discovery|pattern|evolution|improvement|adaptation|growth|insight|realization|figured out|makes sense|clicked|understanding/i,
            contentTypes: ['pattern'],
            primary: 'mem0',
            reasoning: 'Personal learning patterns and insights are semantic memories with relationship potential'
        },
        // Personal projects and work - dual primary storage (Mem0 for experience, MongoDB for structure)
        {
            pattern: /project|working on|building|creating|developing|my.*code|my.*app|my.*website|implementation|feature|bug.*fix|solution|achievement/i,
            contentTypes: ['fact', 'procedure'],
            primary: 'mem0',
            dualPrimary: ['mem0', 'mongodb'],
            reasoning: 'Personal projects combine meaningful experiences (Mem0) with structured technical details (MongoDB)'
        },
        // Cultural content with personal connection - dual primary storage (Mem0 for personal meaning, MongoDB for metadata)
        {
            pattern: /song|music|artist|album|movie|film|book|author|cultural|art|literature|poem|poetry|hebrew|jewish|tradition|festival|holiday/i,
            contentTypes: ['memory', 'fact'],
            primary: 'mem0',
            dualPrimary: ['mem0', 'mongodb'],
            reasoning: 'Cultural content has both personal emotional significance (Mem0) and structured metadata (MongoDB)'
        },
        // Learning discoveries - dual primary storage (Mem0 for breakthrough experience, MongoDB for factual content)
        {
            pattern: /learned that|discovered that|found out that|realized that|understood that|figured out that|breakthrough|discovery|makes sense now|clicked for me|understanding/i,
            contentTypes: ['memory', 'fact'],
            primary: 'mem0',
            dualPrimary: ['mem0', 'mongodb'],
            reasoning: 'Learning discoveries combine personal breakthrough experiences (Mem0) with factual knowledge (MongoDB)'
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
        const matchingRule = this.findMatchingRule(content, contentType, source);
        if (matchingRule) {
            // Check if this rule specifies dual primary storage
            if (matchingRule.dualPrimary && matchingRule.dualPrimary.length > 1) {
                const decision = {
                    primary: matchingRule.dualPrimary[0], // First one is primary for return value
                    secondary: matchingRule.dualPrimary.slice(1), // Rest are also primary but listed as secondary
                    reasoning: `${matchingRule.reasoning} (Dual Primary: ${matchingRule.dualPrimary.join(' + ')})`,
                    cacheStrategy: this.determineCacheStrategy(knowledge)
                };
                console.log(`✅ Dual Primary Storage Decision:`);
                console.log(`   Primary Systems: ${matchingRule.dualPrimary.join(' + ')}`);
                console.log(`   Cache: ${decision.cacheStrategy}`);
                console.log(`   Reasoning: ${decision.reasoning}`);
                return decision;
            }
            else {
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
    findMatchingRule(content, contentType, source) {
        // Pattern match first — most specific signal
        const patternMatch = this.rules.find(rule => rule.pattern.test(content));
        if (patternMatch) {
            // Skip MongoDB-primary technical rules when source is explicitly personal
            if (source === 'personal' && patternMatch.primary === 'mongodb' && !patternMatch.dualPrimary) {
                console.log(`🔍 Pattern matched ${patternMatch.primary} but source=personal — continuing to content type check`);
            }
            else {
                console.log(`🔍 Matched by pattern: ${patternMatch.pattern}`);
                return patternMatch;
            }
        }
        // Fall back to content type match, skipping MongoDB-only rules for personal source
        if (contentType) {
            const typeMatch = this.rules.find(rule => {
                if (!rule.contentTypes.includes(contentType))
                    return false;
                // Don't route personal content to MongoDB-only technical rules
                if (source === 'personal' && rule.primary === 'mongodb' && !rule.dualPrimary)
                    return false;
                return true;
            });
            if (typeMatch) {
                console.log(`📝 Matched by content type: ${contentType}`);
                return typeMatch;
            }
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
                // Personal memories in Mem0 → Store metadata in MongoDB for structured queries
                secondary.push('mongodb');
                // If it has relationships, also store in Neo4j
                if (knowledge.relationships && knowledge.relationships.length > 0) {
                    secondary.push('neo4j');
                }
                break;
            case 'neo4j':
                // Concept relationships in Neo4j → Index in Mem0 for semantic search
                secondary.push('mem0');
                // If it's technical/structured content, store details in MongoDB
                if (knowledge.source === 'technical' || knowledge.contentType === 'procedure') {
                    secondary.push('mongodb');
                }
                break;
            case 'mongodb':
                // Structured data in MongoDB → Index in Mem0 for personal search
                secondary.push('mem0');
                // Personal source or content describing people/orgs/events → also extract to Neo4j
                const content = knowledge.content || '';
                if (knowledge.source === 'personal' ||
                    /relationship|connect|link|associate|relate|person|company|organization|event/i.test(content)) {
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
        const storageType = rule.dualPrimary ? `dual(${rule.dualPrimary.join('+')})` : rule.primary;
        console.log(`➕ Added custom routing rule for ${storageType}: ${rule.pattern}`);
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
