/**
 * Intelligent Storage Router
 * Graph backend (Neo4j or SparrowDB) + Mem0 always (knowledge graph + semantic layer).
 * MongoDB added only for structured/procedural/technical content.
 */

import { UnifiedKnowledge, StorageDecision, CacheLevel } from '../types/index.js'
import { logger } from '../logger.js'

// Pattern that signals content needs MongoDB structured storage in addition to the baseline
const MONGODB_PATTERN =
  /config|configuration|setting|schema|setup|installation|procedure|step.*by.*step|documentation|specification|authentication|API|endpoint|database|server|deployment|build|compile|debug|error.*log|stack.*trace/i

export class IntelligentStorageRouter {
  /**
   * Analyze knowledge and determine optimal storage strategy.
   *
   * Architecture:
   *   primary  = neo4j   (knowledge graph — every fact becomes entities + edges)
   *   secondary[0] = mem0  (semantic layer — always present for episodic/semantic recall)
   *   secondary[1] = mongodb  (opt-in — only for procedural/technical/structured content)
   */
  determineStorage(knowledge: Partial<UnifiedKnowledge>): StorageDecision {
    const content = knowledge.content || ''
    const contentType = knowledge.contentType
    const source = knowledge.source

    logger.debug(`🧠 Analyzing storage for: "${content.slice(0, 50)}..."`)
    logger.debug(`   Content Type: ${contentType}, Source: ${source}`)

    const addMongoDB = this.needsStructuredStorage(content, contentType, source)

    const secondary: ('mem0' | 'neo4j' | 'mongodb')[] = ['mem0']
    if (addMongoDB) secondary.push('mongodb')

    const reasoning = addMongoDB
      ? 'Neo4j (knowledge graph) + Mem0 (semantic layer) + MongoDB (structured content)'
      : 'Neo4j (knowledge graph) + Mem0 (semantic layer)'

    const decision: StorageDecision = {
      primary: 'neo4j',
      secondary,
      reasoning,
      cacheStrategy: this.determineCacheStrategy(knowledge)
    }

    logger.debug(`✅ Storage Decision:`)
    logger.debug(`   Primary: ${decision.primary}`)
    logger.debug(`   Secondary: ${decision.secondary?.join(', ')}`)
    logger.debug(`   Cache: ${decision.cacheStrategy}`)
    logger.debug(`   Reasoning: ${decision.reasoning}`)

    return decision
  }

  /**
   * Determine whether MongoDB structured storage should be added alongside the baseline.
   */
  private needsStructuredStorage(
    content: string,
    contentType?: string,
    source?: string
  ): boolean {
    if (contentType === 'procedure') return true
    if (source === 'technical') return true
    if (MONGODB_PATTERN.test(content)) return true
    return false
  }
  
  /**
   * Determine cache strategy based on knowledge characteristics
   */
  private determineCacheStrategy(knowledge: Partial<UnifiedKnowledge>): CacheLevel {
    // Personal user queries - cache aggressively
    if (knowledge.source === 'personal') {
      logger.debug(`🚀 L1 cache for personal user content`)
      return 'L1'
    }
    
    // Personal memories and insights - cache moderately
    if (knowledge.contentType === 'memory' || knowledge.contentType === 'insight') {
      logger.debug(`⚡ L2 cache for personal memory/insight content`)
      return 'L2'
    }
    
    // High confidence knowledge - cache moderately
    if (knowledge.confidence && knowledge.confidence > 0.8) {
      logger.debug(`⚡ L2 cache for high confidence content`)
      return 'L2'
    }
    
    // Technical knowledge - cache conservatively
    if (knowledge.source === 'technical' || knowledge.contentType === 'procedure') {
      logger.debug(`💾 L3 cache for technical/procedural content`)
      return 'L3'
    }
    
    // Everything else - conservative caching
    logger.debug(`💾 L3 cache for general content`)
    return 'L3'
  }

  /**
   * Get routing statistics for analytics
   */
  getRoutingStats(): Record<string, any> {
    return {
      architecture: `${process.env.KMS_STORAGE_BACKEND === 'sparrowdb' ? 'sparrowdb' : 'neo4j'}+mem0 always, mongodb additive`,
      baseline: ['neo4j', 'mem0'],
      mongodbTriggers: ['contentType=procedure', 'source=technical', 'MONGODB_PATTERN match']
    }
  }

  /**
   * Test routing decision for given content (useful for debugging)
   */
  testRouting(content: string, contentType?: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'): StorageDecision {
    return this.determineStorage({ content, contentType })
  }
}
