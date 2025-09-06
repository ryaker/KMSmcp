/**
 * Redis Keep-Alive Manager
 * Automatically sends periodic pings to keep Upstash Redis active
 */

import { Redis } from 'ioredis'

export class RedisKeepAlive {
  private intervalId?: NodeJS.Timeout
  private isRunning = false
  private pingCount = 0
  
  constructor(
    private redis: Redis,
    private intervalMinutes: number = 60 * 24 // Default: 24 hours (once per day)
  ) {}
  
  /**
   * Start the keep-alive process
   */
  start(): void {
    if (this.isRunning) {
      console.log('⚠️  Redis keep-alive already running')
      return
    }
    
    console.log(`🔄 Starting Redis keep-alive (interval: ${this.intervalMinutes} minutes)`)
    
    // Run immediately on start
    this.ping().catch(console.error)
    
    // Set up interval
    this.intervalId = setInterval(() => {
      this.ping().catch(console.error)
    }, this.intervalMinutes * 60 * 1000)
    
    this.isRunning = true
  }
  
  /**
   * Stop the keep-alive process
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    this.isRunning = false
    console.log('🛑 Redis keep-alive stopped')
  }
  
  /**
   * Send a ping to Redis to keep it active
   */
  private async ping(): Promise<void> {
    try {
      const timestamp = new Date().toISOString()
      
      // 1. Update keep-alive timestamp
      await this.redis.set('kms:keep-alive:last-ping', timestamp)
      
      // 2. Increment counter
      this.pingCount++
      await this.redis.set('kms:keep-alive:ping-count', this.pingCount.toString())
      
      // 3. Set a test entry with TTL (5 minutes)
      await this.redis.setex(
        `kms:keep-alive:test:${Date.now()}`,
        300,
        JSON.stringify({
          timestamp,
          ping: this.pingCount,
          source: 'mcp-server'
        })
      )
      
      // 4. Clean up old test entries (keep only last 5)
      const testKeys = await this.redis.keys('kms:keep-alive:test:*')
      if (testKeys.length > 5) {
        const sortedKeys = testKeys.sort()
        const toDelete = sortedKeys.slice(0, sortedKeys.length - 5)
        if (toDelete.length > 0) {
          await this.redis.del(...toDelete)
        }
      }
      
      console.log(`🏓 Redis keep-alive ping #${this.pingCount} sent at ${timestamp}`)
    } catch (error) {
      console.error('❌ Redis keep-alive ping failed:', error instanceof Error ? error.message : error)
    }
  }
  
  /**
   * Get keep-alive status
   */
  async getStatus(): Promise<{
    isRunning: boolean
    pingCount: number
    lastPing: string | null
    intervalMinutes: number
  }> {
    const lastPing = await this.redis.get('kms:keep-alive:last-ping').catch(() => null)
    
    return {
      isRunning: this.isRunning,
      pingCount: this.pingCount,
      lastPing,
      intervalMinutes: this.intervalMinutes
    }
  }
}