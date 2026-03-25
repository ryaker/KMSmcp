/**
 * MongoDB Storage System Implementation
 */

import { MongoClient, Db, Collection } from 'mongodb'
import { createHash } from 'node:crypto'
import { StorageSystem, UnifiedKnowledge, KnowledgeQuery, KMSConfig } from '../types/index.js'

export interface StoredDocument {
  id: string
  title: string
  content: string
  docType: string
  sourceUrl?: string
  publishedDate?: string
  tags: string[]
  wordCount: number
  storedAt: Date
  userId: string
  contentHash: string
}

export class MongoDBStorage implements StorageSystem {
  public name = 'mongodb'
  private client!: MongoClient
  private db!: Db
  private collection!: Collection<UnifiedKnowledge>
  private documents!: Collection<StoredDocument>

  constructor(private config: KMSConfig['mongodb']) {}

  async initialize(): Promise<void> {
    console.log('📄 Connecting to MongoDB...')
    this.client = new MongoClient(this.config.uri)
    await this.client.connect()
    this.db = this.client.db(this.config.database)
    this.collection = this.db.collection<UnifiedKnowledge>('unified_knowledge')
    this.documents = this.db.collection<StoredDocument>('documents')

    // Create indexes for better search performance
    await this.createIndexes()
    
    console.log(`✅ MongoDB connected to database: ${this.config.database}`)
  }

  /**
   * Compute a content fingerprint for deduplication.
   * Uses first 300 chars of trimmed, lowercased content so that timestamps
   * and minor whitespace differences don't create duplicate documents.
   */
  private contentFingerprint(content: string): string {
    const normalized = content.trim().toLowerCase().slice(0, 300)
    return createHash('sha256').update(normalized).digest('hex')
  }

  async store(knowledge: UnifiedKnowledge): Promise<void> {
    try {
      console.log(`📄 Storing in MongoDB: ${knowledge.id}`)
      const contentHash = this.contentFingerprint(knowledge.content)
      const docWithHash = { ...knowledge, contentHash }

      // Upsert on contentHash — prevents duplicate documents when the same
      // content is stored at different timestamps.
      const result = await this.collection.updateOne(
        { contentHash },
        { $setOnInsert: docWithHash },
        { upsert: true }
      )

      if (result.upsertedCount > 0) {
        console.log(`✅ Successfully stored in MongoDB (new document)`)
      } else {
        console.log(`⚠️  MongoDB: duplicate content detected, skipped insert (contentHash: ${contentHash.slice(0, 8)}…)`)
      }
    } catch (error) {
      console.error('❌ MongoDB storage error:', error)
      throw error
    }
  }

  async search(query: KnowledgeQuery): Promise<any[]> {
    try {
      console.log(`🔍 Searching MongoDB: "${query.query}"`)
      
      const filter: any = {}
      
      // Text search — split into keywords so "MCP session recovery" finds docs containing
      // those words individually, not the exact phrase as a substring.
      if (query.query) {
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const keywords = query.query
          .split(/\s+/)
          .map(k => k.trim())
          .filter(k => k.length >= 2) // keep short technical terms like "AI", "C#" but skip noisy 1-char tokens

        if (keywords.length > 0) {
          filter.$or = keywords.flatMap(k => [
            { content: { $regex: escapeRegex(k), $options: 'i' } },
            { 'metadata.tags': { $regex: escapeRegex(k), $options: 'i' } }
          ])
        }
      }
      
      // Apply filters
      if (query.filters?.contentType) {
        filter.contentType = { $in: query.filters.contentType }
      }
      if (query.filters?.source) {
        filter.source = { $in: query.filters.source }
      }
      if (query.filters?.userId) {
        filter.userId = query.filters.userId
      }
      if (query.filters?.minConfidence) {
        filter.confidence = { $gte: query.filters.minConfidence }
      }
      if (query.filters?.timeRange) {
        filter.timestamp = {
          $gte: query.filters.timeRange.start,
          $lte: query.filters.timeRange.end
        }
      }
      
      const results = await this.collection
        .find(filter)
        .sort({ confidence: -1, timestamp: -1 })
        .limit(query.options?.maxResults || 10)
        .toArray()
      
      console.log(`📄 MongoDB found ${results.length} results`)
      
      return results.map((doc: any) => ({
        id: doc.id,
        content: doc.content,
        confidence: doc.confidence,
        metadata: doc.metadata,
        sourceSystem: 'mongodb',
        timestamp: doc.timestamp,
        contentType: doc.contentType,
        source: doc.source
      }))
    } catch (error) {
      console.warn('⚠️ MongoDB search error:', error)
      return []
    }
  }

  async getStats(): Promise<Record<string, any>> {
    try {
      const totalDocuments = await this.collection.countDocuments()
      
      // Get distribution by content type
      const contentTypeStats = await this.collection.aggregate([
        { $group: { _id: '$contentType', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).toArray()
      
      // Get distribution by source
      const sourceStats = await this.collection.aggregate([
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).toArray()
      
      // Get recent activity
      const recentActivity = await this.collection.aggregate([
        { 
          $match: { 
            timestamp: { 
              $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
            } 
          } 
        },
        { $count: 'recent' }
      ]).toArray()
      
      return {
        totalDocuments,
        contentTypes: Object.fromEntries(
          contentTypeStats.map((stat: any) => [stat._id, stat.count])
        ),
        sources: Object.fromEntries(
          sourceStats.map((stat: any) => [stat._id, stat.count])
        ),
        recentActivity: recentActivity[0]?.recent || 0,
        collections: ['unified_knowledge'],
        status: 'connected',
        database: this.config.database
      }
    } catch (error) {
      console.error('❌ MongoDB stats error:', error)
      return {
        totalDocuments: 0,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async findById(id: string): Promise<UnifiedKnowledge | null> {
    try {
      const result = await this.collection.findOne({ id })
      return result
    } catch (error) {
      console.error('❌ MongoDB findById error:', error)
      return null
    }
  }

  async update(id: string, updates: Partial<UnifiedKnowledge>): Promise<boolean> {
    try {
      const result = await this.collection.updateOne(
        { id },
        { $set: { ...updates, timestamp: new Date() } }
      )
      return result.modifiedCount > 0
    } catch (error) {
      console.error('❌ MongoDB update error:', error)
      return false
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const result = await this.collection.deleteOne({ id })
      return result.deletedCount > 0
    } catch (error) {
      console.error('❌ MongoDB delete error:', error)
      return false
    }
  }

  async storeDocument(doc: Omit<StoredDocument, 'contentHash'>): Promise<{ id: string; isNew: boolean }> {
    const contentHash = createHash('sha256')
      .update(doc.content.trim().toLowerCase())
      .digest('hex')
    const docWithHash: StoredDocument = { ...doc, contentHash }

    const result = await this.documents.updateOne(
      { contentHash },
      { $setOnInsert: docWithHash },
      { upsert: true }
    )

    if (result.upsertedCount > 0) {
      return { id: doc.id, isNew: true }
    }

    // Duplicate detected — return the existing persisted document's id
    const existing = await this.documents.findOne({ contentHash }, { projection: { id: 1 } })
    return { id: existing?.id ?? doc.id, isNew: false }
  }

  async searchDocuments(query: string, tags?: string[], limit = 10, userId?: string): Promise<StoredDocument[]> {
    const filter: any = {}
    if (userId) {
      filter.userId = userId
    }
    if (query) {
      const kws = query.split(/\s+/).map(k => k.trim()).filter(k => k.length >= 2)
      if (kws.length === 0 && !tags?.length) {
        return []
      }
      if (kws.length > 0) {
        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        filter.$or = kws.flatMap(k => [
          { content: { $regex: esc(k), $options: 'i' } },
          { title: { $regex: esc(k), $options: 'i' } },
          { tags: { $regex: esc(k), $options: 'i' } }
        ])
      }
    }
    if (tags?.length) {
      filter.tags = { $in: tags }
    }
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 10))
    return this.documents.find(filter).sort({ storedAt: -1 }).limit(safeLimit).toArray()
  }

  private async createIndexes(): Promise<void> {
    try {
      // Text index for search
      await this.collection.createIndex({ 
        content: 'text', 
        'metadata.tags': 'text' 
      })
      
      // Query optimization indexes
      await this.collection.createIndex({ contentType: 1 })
      await this.collection.createIndex({ source: 1 })
      await this.collection.createIndex({ userId: 1 })
      await this.collection.createIndex({ confidence: -1 })
      await this.collection.createIndex({ timestamp: -1 })

      // Unique index for deduplication via content fingerprint
      await this.collection.createIndex({ contentHash: 1 }, { unique: true, sparse: true })

      // Compound indexes for common queries
      await this.collection.createIndex({ userId: 1, contentType: 1 })

      // documents collection indexes
      await this.documents.createIndex({ contentHash: 1 }, { unique: true, sparse: true })
      await this.documents.createIndex({ content: 'text', title: 'text', tags: 'text' })
      await this.documents.createIndex({ storedAt: -1 })
      await this.documents.createIndex({ docType: 1 })
      await this.documents.createIndex({ tags: 1 })

      console.log('📄 MongoDB indexes created successfully')
    } catch (error) {
      console.warn('⚠️ MongoDB index creation warning:', error)
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close()
      console.log('📄 MongoDB connection closed')
    }
  }
}
