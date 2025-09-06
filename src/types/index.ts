/**
 * Core Types for Unified KMS MCP Server
 */

import { OAuthConfig } from '../auth/types.js'

export interface KMSConfig {
  mongodb: {
    uri: string
    database: string
  }
  neo4j: {
    uri: string
    username: string
    password: string
  }
  mem0: {
    apiKey: string
    orgId?: string
    defaultUserId?: string
  }
  redis: {
    uri: string
  }
  fact: {
    l1CacheSize: number
    l2CacheTTL: number
    l3CacheTTL: number
  }
  transport: {
    mode: 'stdio' | 'http' | 'dual'
    http?: {
      port: number
      host?: string
      cors?: {
        origin?: string | string[]
        credentials?: boolean
      }
      rateLimit?: {
        windowMs?: number
        max?: number
      }
    }
  }
  oauth?: OAuthConfig
}

export interface UnifiedKnowledge {
  id: string
  content: string
  contentType: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'
  source: 'coaching' | 'personal' | 'technical' | 'cross_domain'
  userId?: string
  coachId?: string
  metadata: Record<string, any>
  timestamp: Date
  confidence: number
  relationships?: Array<{
    targetId: string
    type: string
    strength: number
  }>
}

export interface StorageDecision {
  primary: 'mem0' | 'neo4j' | 'mongodb'
  secondary?: ('mem0' | 'neo4j' | 'mongodb')[]
  reasoning: string
  cacheStrategy: 'L1' | 'L2' | 'L3' | 'skip'
}

export interface KnowledgeQuery {
  query: string
  filters?: {
    contentType?: string[]
    source?: string[]
    userId?: string
    coachId?: string
    timeRange?: { start: Date, end: Date }
    minConfidence?: number
  }
  options?: {
    includeRelationships?: boolean
    maxResults?: number
    useFACTCache?: boolean
    cacheStrategy?: 'aggressive' | 'conservative' | 'realtime'
  }
}

export interface FACTCacheLayer {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttl?: number): Promise<void>
  invalidate(pattern: string): Promise<void>
  getStats(): Promise<Record<string, any>>
}

export interface StorageSystem {
  name: string
  store(knowledge: UnifiedKnowledge): Promise<void>
  search(query: KnowledgeQuery): Promise<any[]>
  getStats(): Promise<Record<string, any>>
}

export interface RoutingRule {
  pattern: RegExp
  contentTypes: string[]
  primary: 'mem0' | 'neo4j' | 'mongodb'
  reasoning: string
}

export type CacheLevel = 'L1' | 'L2' | 'L3' | 'skip'
export type SystemName = 'mem0' | 'neo4j' | 'mongodb'
