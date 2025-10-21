#!/usr/bin/env tsx
/**
 * Auth0 Dynamic Client Cleanup Script
 *
 * Deletes old dynamically registered OAuth clients from Auth0 to prevent hitting client limits.
 *
 * Usage:
 *   doppler run -- tsx scripts/cleanup-auth0-clients.ts [--dry-run] [--days=7]
 *
 * Options:
 *   --dry-run  Show what would be deleted without actually deleting
 *   --days=N   Delete clients older than N days (default: 7)
 *
 * Required Environment Variables (from Doppler):
 *   AUTH0_DOMAIN          - Your Auth0 domain (e.g., dev-xyz.us.auth0.com)
 *   AUTH0_CLIENT_ID       - Auth0 Management API client ID
 *   AUTH0_CLIENT_SECRET   - Auth0 Management API client secret
 */

import fetch from 'node-fetch'

interface Auth0Client {
  client_id: string
  name: string
  created_at: string
  app_type: string
  grant_types?: string[]
  client_metadata?: Record<string, string>
}

interface Auth0Token {
  access_token: string
  token_type: string
  expires_in: number
}

class Auth0ClientCleanup {
  private domain: string
  private clientId: string
  private clientSecret: string
  private accessToken?: string

  constructor() {
    this.domain = process.env.AUTH0_DOMAIN || process.env.OAUTH_ISSUER?.replace('https://', '').replace(/\/$/, '') || ''
    this.clientId = process.env.AUTH0_CLIENT_ID || process.env.OAUTH_CLIENT_ID || ''
    this.clientSecret = process.env.AUTH0_CLIENT_SECRET || process.env.OAUTH_CLIENT_SECRET || ''

    if (!this.domain || !this.clientId || !this.clientSecret) {
      console.error('❌ Missing required environment variables:')
      console.error('   AUTH0_DOMAIN (or OAUTH_ISSUER)')
      console.error('   AUTH0_CLIENT_ID (or OAUTH_CLIENT_ID)')
      console.error('   AUTH0_CLIENT_SECRET (or OAUTH_CLIENT_SECRET)')
      console.error('\n💡 Run with: doppler run -- tsx scripts/cleanup-auth0-clients.ts')
      process.exit(1)
    }

    // Ensure domain doesn't have protocol
    this.domain = this.domain.replace('https://', '').replace(/\/$/, '')
  }

  /**
   * Get Management API access token
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken
    }

    const response = await fetch(`https://${this.domain}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: `https://${this.domain}/api/v2/`,
        grant_type: 'client_credentials'
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get Auth0 access token: ${response.status} ${error}`)
    }

    const data = await response.json() as Auth0Token
    this.accessToken = data.access_token
    return this.accessToken
  }

  /**
   * Get all clients from Auth0
   */
  async getAllClients(): Promise<Auth0Client[]> {
    const token = await this.getAccessToken()
    const clients: Auth0Client[] = []
    let page = 0
    const perPage = 100

    while (true) {
      const response = await fetch(
        `https://${this.domain}/api/v2/clients?page=${page}&per_page=${perPage}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      )

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to fetch clients: ${response.status} ${error}`)
      }

      const pageClients = await response.json() as Auth0Client[]

      if (pageClients.length === 0) {
        break
      }

      clients.push(...pageClients)

      if (pageClients.length < perPage) {
        break
      }

      page++
    }

    return clients
  }

  /**
   * Delete a client by ID
   */
  async deleteClient(clientId: string): Promise<void> {
    const token = await this.getAccessToken()

    const response = await fetch(
      `https://${this.domain}/api/v2/clients/${clientId}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    )

    if (!response.ok && response.status !== 204) {
      const error = await response.text()
      throw new Error(`Failed to delete client ${clientId}: ${response.status} ${error}`)
    }
  }

  /**
   * Find dynamically registered clients older than specified days
   */
  findOldDynamicClients(clients: Auth0Client[], daysOld: number): Auth0Client[] {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    return clients.filter(client => {
      // Filter for dynamically registered clients
      // These typically have grant_types including 'client_credentials' or 'authorization_code'
      // and may have specific metadata or naming patterns
      const isDynamic =
        client.name?.toLowerCase().includes('dynamic') ||
        client.name?.toLowerCase().includes('mcp') ||
        client.client_metadata?.dynamically_registered === 'true' ||
        (client.grant_types?.includes('authorization_code') &&
         client.grant_types?.includes('refresh_token'))

      if (!isDynamic) {
        return false
      }

      // Check age
      const createdAt = new Date(client.created_at)
      return createdAt < cutoffDate
    })
  }

  /**
   * Run the cleanup process
   */
  async cleanup(dryRun: boolean, daysOld: number): Promise<void> {
    console.log('🔍 Auth0 Dynamic Client Cleanup')
    console.log('━'.repeat(60))
    console.log(`   Domain: ${this.domain}`)
    console.log(`   Mode: ${dryRun ? '🔍 DRY RUN (no deletions)' : '🗑️  DELETE MODE'}`)
    console.log(`   Age threshold: ${daysOld} days`)
    console.log('━'.repeat(60))
    console.log('')

    // Get all clients
    console.log('📥 Fetching all clients...')
    const allClients = await this.getAllClients()
    console.log(`   Found ${allClients.length} total clients`)

    // Find old dynamic clients
    const oldClients = this.findOldDynamicClients(allClients, daysOld)
    console.log(`   Found ${oldClients.length} old dynamic clients to clean up`)
    console.log('')

    if (oldClients.length === 0) {
      console.log('✅ No old dynamic clients to clean up!')
      return
    }

    // Show what will be deleted
    console.log('📋 Clients to be deleted:')
    console.log('━'.repeat(60))
    oldClients.forEach((client, index) => {
      const age = Math.floor((Date.now() - new Date(client.created_at).getTime()) / (1000 * 60 * 60 * 24))
      console.log(`   ${index + 1}. ${client.name}`)
      console.log(`      ID: ${client.client_id}`)
      console.log(`      Created: ${client.created_at} (${age} days ago)`)
      console.log(`      Type: ${client.app_type}`)
      console.log('')
    })

    if (dryRun) {
      console.log('🔍 DRY RUN - No clients were deleted')
      console.log(`   To actually delete, run: doppler run -- tsx scripts/cleanup-auth0-clients.ts --days=${daysOld}`)
      return
    }

    // Delete clients
    console.log('🗑️  Deleting clients...')
    let deleted = 0
    let failed = 0

    for (const client of oldClients) {
      try {
        await this.deleteClient(client.client_id)
        console.log(`   ✅ Deleted: ${client.name}`)
        deleted++
      } catch (error) {
        console.error(`   ❌ Failed to delete ${client.name}: ${error}`)
        failed++
      }
    }

    console.log('')
    console.log('━'.repeat(60))
    console.log('✅ Cleanup completed!')
    console.log(`   Deleted: ${deleted} clients`)
    if (failed > 0) {
      console.log(`   Failed: ${failed} clients`)
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const daysArg = args.find(arg => arg.startsWith('--days='))
const daysOld = daysArg ? parseInt(daysArg.split('=')[1]) : 7

// Run cleanup
const cleanup = new Auth0ClientCleanup()
cleanup.cleanup(dryRun, daysOld).catch(error => {
  console.error('❌ Cleanup failed:', error)
  process.exit(1)
})
