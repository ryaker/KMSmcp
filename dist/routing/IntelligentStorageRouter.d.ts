/**
 * Intelligent Storage Router
 * Analyzes knowledge content and determines optimal storage strategy
 */
import { UnifiedKnowledge, StorageDecision, RoutingRule } from '../types/index.js';
interface DualPrimaryRule extends RoutingRule {
    dualPrimary?: ('mem0' | 'neo4j' | 'mongodb')[];
}
export declare class IntelligentStorageRouter {
    private rules;
    /**
     * Analyze knowledge and determine optimal storage strategy
     */
    determineStorage(knowledge: Partial<UnifiedKnowledge>): StorageDecision;
    /**
     * Find the best matching rule for given content
     */
    private findMatchingRule;
    /**
     * Determine secondary storage systems for cross-linking
     */
    private getSecondaryStorage;
    /**
     * Determine cache strategy based on knowledge characteristics
     */
    private determineCacheStrategy;
    /**
     * Get routing statistics for analytics
     */
    getRoutingStats(): Record<string, any>;
    /**
     * Test routing decision for given content (useful for debugging)
     */
    testRouting(content: string, contentType?: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'): StorageDecision;
    /**
     * Add custom routing rule
     */
    addRule(rule: DualPrimaryRule): void;
    /**
     * Remove routing rule by pattern
     */
    removeRule(pattern: RegExp): void;
}
export {};
//# sourceMappingURL=IntelligentStorageRouter.d.ts.map