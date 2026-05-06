/**
 * Core Types for Unified KMS MCP Server
 */

import { OAuthConfig } from '../auth/types.js'

export interface KMSConfig {
  mongodb: {
    uri: string
    database: string
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

export type KnowledgeFlag = 'RETRACTED' | 'SUPERSEDED' | 'DELETED' | 'UNVERIFIED'

export interface UnifiedKnowledge {
  id: string
  content: string
  contentType: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'
  source: 'personal' | 'technical' | 'cross_domain'
  userId?: string
  metadata: Record<string, any>
  timestamp: Date
  confidence: number
  relationships?: Array<{
    targetId: string
    type: string
    strength: number
  }>
  // Soft-delete / correction fields. All optional, all default to undefined.
  // Read paths default-exclude entries with flag != null. The reaper hard-deletes
  // entries where flag != null AND flag_date < now - 90 days.
  flag?: KnowledgeFlag | null
  flag_note?: string
  flag_date?: Date
  flag_by?: string
  superseded_by?: string  // ID of the entry that replaces this one (set on the OLD entry)
}

export interface StorageDecision {
  primary: 'mem0' | 'graph' | 'mongodb'
  secondary?: ('mem0' | 'graph' | 'mongodb')[]
  reasoning: string
  cacheStrategy: 'L1' | 'L2' | 'L3' | 'skip'
}

export interface KnowledgeQuery {
  query: string
  filters?: {
    contentType?: string[]
    source?: string[]
    userId?: string
    timeRange?: { start: Date, end: Date }
    minConfidence?: number
    // First-class facet filter (DG-FACET-A). Matches against metadata.subject,
    // typically a dotted path like "Phoenix.camera_count" or
    // "Rich.preferences.communication_style". Used by the upcoming dedup gate
    // (DG-T1-B) to narrow candidate search before vector similarity, and by
    // callers who want O(1) filtering on a known facet without LLM extraction.
    // String → exact match. String[] → match any. Subject is a pure
    // pass-through field: stored verbatim, no normalization.
    subject?: string | string[]
  }
  options?: {
    includeRelationships?: boolean
    maxResults?: number
    useFACTCache?: boolean
    cacheStrategy?: 'aggressive' | 'conservative' | 'realtime'
    // When true, search returns flagged (retracted/superseded/deleted) entries.
    // Default false — flagged entries are hidden from normal reads.
    includeFlagged?: boolean
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
  primary: 'mem0' | 'graph' | 'mongodb'
  reasoning: string
}

export type CacheLevel = 'L1' | 'L2' | 'L3' | 'skip'
export type SystemName = 'mem0' | 'graph' | 'mongodb'

// Shared interfaces for graph storage backends (SparrowDBStorage)
export interface KnownPersonEntry {
  canonical: string
  allNames: string[]
  sex: string | null
  relationshipToRich: string | null
  status: string
  businessRole: string | null
  familyTitle: string | null
}

export interface KnownPeopleConfig {
  _meta: { generatedAt: string; totalPeople: number; totalNameVariants: number }
  people: Record<string, KnownPersonEntry>
  nameIndex: Record<string, string>  // normalized name → canonical node id
}

// Graph storage backend interface — implemented by SparrowDBStorage
export interface GraphStorage extends StorageSystem {
  initialize(): Promise<void>
  close(): Promise<void>
  resolvePersonId(rawName: string): Promise<string | null>
  findRelated(nodeId: string, maxDepth?: number): Promise<any[]>
  getEntitySummary(id: string): Promise<Record<string, any> | null>
  getOperationalNodes(): Promise<Array<{
    id: string
    type: string
    name: string
    description: string
    actions: string[]
    taskPattern?: string
  }>>
  getEntityCandidates(): Promise<Array<{
    id: string
    name: string
    labels: string[]
    aliases: string[]
  }>>
  createAboutRelationships(sourceId: string, targetEntityIds: string[]): Promise<void>
  // Corrective operations — implemented by SparrowDBStorage. Optional on the
  // interface so future graph backends can omit them; callers should check for
  // the method before invoking.
  delete?(id: string): Promise<boolean>
  update?(id: string, updates: Partial<UnifiedKnowledge>): Promise<boolean>
  flag?(
    id: string,
    flag: KnowledgeFlag | null,
    note?: string,
    by?: string,
    superseded_by?: string
  ): Promise<boolean>
  findById?(id: string): { id: string; flag?: KnowledgeFlag | null; flag_date?: string; [k: string]: any } | null
  listFlagged?(): Array<{ id: string; flag?: KnowledgeFlag | null; flag_date?: string; [k: string]: any }>
  // Embedding write (DG-T1-A) — persists a 768-dim vector into the HNSW index
  // for the (Knowledge, embedding) tuple. Optional so older bindings degrade.
  storeEmbedding?(id: string, embedding: Float32Array, embedderId: string): Promise<boolean>
  // Top-K vector retrieval (DG-T1-B) — used by the dedup gate to find
  // candidate near-duplicates before persisting a new unified_store call.
  // Optional so non-vector backends degrade to "no dedup".
  findSimilar?(
    embedding: Float32Array,
    options: {
      userId: string
      contentType?: string
      subject?: string
      topK?: number
      includeFlagged?: boolean
    }
  ): Promise<Array<{
    id: string
    similarity: number
    contentType: string
    source: string
    subject?: string
    created: string
    flag?: string | null
    content_preview: string
  }>>
}
