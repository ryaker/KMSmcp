/**
 * MongoDB Storage System Implementation
 */

import { MongoClient, Db, Collection } from 'mongodb'
import { StorageSystem, UnifiedKnowledge, KnowledgeQuery, KMSConfig } from '../types/index.js'

export class MongoDBStorage implements StorageSystem {
  public name = 'mongodb'
  private client!: MongoClient
  private db!: Db
  private collection!: Collection<UnifiedKnowledge>

  constructor(private config: KMSConfig['mongodb']) {}

  async initialize(): Promise<void> {
    console.log('📄 Connecting to MongoDB...')
    this.client = new MongoClient(this.config.uri)
    await this.client.connect()
    this.db = this.client.db(this.config.database)
    this.collection = this.db.collection<UnifiedKnowledge>('unified_knowledge')
    
    // Create indexes for better search performance
    await this.createIndexes()
    
    console.log(`✅ MongoDB connected to database: ${this.config.database}`)
  }

  async store(knowledge: UnifiedKnowledge): Promise<void> {
    try {
      console.log(`📄 Storing in MongoDB: ${knowledge.id}`)
      await this.collection.insertOne(knowledge)
      console.log(`✅ Successfully stored in MongoDB`)
    } catch (error) {
      console.error('❌ MongoDB storage error:', error)
      throw error
    }
  }

  async search(query: KnowledgeQuery): Promise<any[]> {
    try {
      console.log(`🔍 Searching MongoDB: "${query.query}"`)
      
      const filter: any = {}
      
      // Text search
      if (query.query) {
        filter.$or = [
          { content: { $regex: query.query, $options: 'i' } },
          { 'metadata.tags': { $regex: query.query, $options: 'i' } }
        ]
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
      if (query.filters?.coachId) {
        filter.coachId = query.filters.coachId
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
      await this.collection.createIndex({ coachId: 1 })
      await this.collection.createIndex({ confidence: -1 })
      await this.collection.createIndex({ timestamp: -1 })
      
      // Compound indexes for common queries
      await this.collection.createIndex({ userId: 1, contentType: 1 })
      await this.collection.createIndex({ coachId: 1, confidence: -1 })
      
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
