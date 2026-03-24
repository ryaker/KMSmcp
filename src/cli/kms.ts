#!/usr/bin/env node
/**
 * KMS CLI — agent/Claude Code interface to the KMS MCP server
 *
 * Mirrors the MCP tools (unified_store, unified_search, kms_ping, get_storage_recommendation)
 * so that CLI agents (Claude Code, shell scripts, CI) can use KMS without a MCP client.
 *
 * Usage (run with doppler for secrets):
 *   doppler run -- tsx src/cli/kms.ts <command> [options]
 *   doppler run -- node dist/cli/kms.js <command> [options]
 *
 * Commands:
 *   store    Store knowledge
 *   search   Search knowledge
 *   ping     Health check
 *   route    Show routing decision without storing
 *
 * Examples:
 *   kms store "DirecTV rejected me after final round in 2024" --type fact --source personal
 *   kms search "job rejections" --limit 5
 *   kms ping
 *   kms route "npm install --save-dev typescript" --type procedure
 */

import { parseArgs } from 'node:util'
import { MongoDBStorage } from '../storage/MongoDBStorage.js'
import { Neo4jStorage } from '../storage/Neo4jStorage.js'
import { SparrowDBStorage } from '../storage/SparrowDBStorage.js'
import { Mem0Storage } from '../storage/Mem0Storage.js'
import { IntelligentStorageRouter } from '../routing/IntelligentStorageRouter.js'
import { OllamaStorageRouter } from '../routing/OllamaStorageRouter.js'
import { OllamaInference } from '../inference/OllamaInference.js'
import { EnrichmentQueue } from '../inference/EnrichmentQueue.js'
import { EntityLinker } from '../inference/EntityLinker.js'
import { UnifiedStoreTool } from '../tools/UnifiedStoreTool.js'
import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`Error: ${msg}`)
  process.exit(1)
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

function usage(): void {
  console.log(`
Usage: kms <command> [options]

Commands:
  store <content>   Store knowledge in KMS
  search <query>    Search KMS
  ping              Health check all storage systems
  route <content>   Show routing decision without storing

Options for store:
  --type, -t        Content type: memory|insight|pattern|relationship|fact|procedure
  --source, -s      Source: personal|technical|cross_domain
  --user-id, -u     User ID (default: KMS_DEFAULT_USER_ID env var)
  --confidence      Confidence 0.0-1.0 (default: 0.8)
  --metadata        JSON metadata object (e.g. '{"company":"Herbalife"}')

Options for search:
  --type, -t        Filter by content type (comma-separated)
  --source, -s      Filter by source (comma-separated)
  --user-id, -u     Filter by user ID
  --limit, -n       Max results (default: 10)
  --no-cache        Skip FACT cache

Options for route:
  --type, -t        Content type hint
  --source, -s      Source hint

Global options:
  --json            Output raw JSON (default: true)
  --help, -h        Show this help
`)
}

// ── Config from env ───────────────────────────────────────────────────────────

function buildConfig() {
  return {
    mongodb: {
      uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
      database: process.env.MONGODB_DATABASE || 'kms'
    },
    neo4j: {
      uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
      username: process.env.NEO4J_USERNAME || 'neo4j',
      password: process.env.NEO4J_PASSWORD || '',
      database: process.env.NEO4J_DATABASE
    },
    mem0: {
      apiKey: process.env.MEM0_API_KEY || '',
      orgId: process.env.MEM0_ORG_ID,
      defaultUserId: process.env.KMS_DEFAULT_USER_ID || 'personal'
    },
    redis: {
      uri: process.env.REDIS_URI || 'redis://localhost:6379'
    },
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'qwen3:8b'
    }
  }
}

// ── Bootstrap storage (lazy, shared across commands) ─────────────────────────

let _storeTool: UnifiedStoreTool | null = null
let _searchTool: UnifiedSearchTool | null = null

async function getTools() {
  if (_storeTool && _searchTool) return { storeTool: _storeTool, searchTool: _searchTool }

  const cfg = buildConfig()

  const mongodb = new MongoDBStorage(cfg.mongodb)
  const mem0 = new Mem0Storage(cfg.mem0)

  // Honour KMS_STORAGE_BACKEND=sparrowdb — same logic as index.ts
  let graphBackend: Neo4jStorage
  if (process.env.KMS_STORAGE_BACKEND === 'sparrowdb') {
    const sparrowPath = process.env.SPARROWDB_PATH || '~/.kms-sparrowdb'
    console.error(`⚡ CLI graph backend: SparrowDB (path: ${sparrowPath})`)
    graphBackend = new SparrowDBStorage({ dbPath: sparrowPath }) as unknown as Neo4jStorage
  } else {
    graphBackend = new Neo4jStorage(cfg.neo4j)
  }

  await Promise.allSettled([
    mongodb.initialize(),
    graphBackend.initialize(),
    mem0.initialize()
  ])

  const router = new IntelligentStorageRouter()
  const ollama = new OllamaInference(cfg.ollama.baseUrl, cfg.ollama.model)
  const ollamaRouter = new OllamaStorageRouter(ollama, router)

  const enrichmentQueue = new EnrichmentQueue(null)
  const entityLinker = new EntityLinker(ollama, graphBackend, mongodb)
  enrichmentQueue.setLinker(entityLinker)

  const storage = { mongodb, neo4j: graphBackend, mem0 }

  // CLI runs without Redis cache (null = no caching)
  _storeTool = new UnifiedStoreTool(router, storage, null, ollamaRouter, enrichmentQueue)
  _searchTool = new UnifiedSearchTool(storage, null)

  return { storeTool: _storeTool, searchTool: _searchTool }
}

async function teardown() {
  // Neo4j driver needs explicit close
  if (_storeTool) {
    // Access via internal storage reference if needed — driver closes on GC in most cases
  }
}

// ── Command: store ────────────────────────────────────────────────────────────

async function cmdStore(args: string[]) {
  const content = args[0]
  if (!content) die('store requires a content argument')

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      type:       { type: 'string', short: 't' },
      source:     { type: 'string', short: 's' },
      'user-id':  { type: 'string', short: 'u' },
      confidence: { type: 'string' },
      metadata:   { type: 'string' }
    },
    strict: false
  })

  let metadata: Record<string, any> | undefined
  if (values.metadata) {
    try { metadata = JSON.parse(values.metadata as string) }
    catch { die(`--metadata is not valid JSON`) }
  }

  const { storeTool } = await getTools()

  const result = await storeTool.store({
    content,
    contentType: values.type as any,
    source: values.source as any,
    userId: values['user-id'] as string | undefined,
    confidence: values.confidence ? parseFloat(values.confidence as string) : undefined,
    metadata
  })

  out(result)
}

// ── Command: search ───────────────────────────────────────────────────────────

async function cmdSearch(args: string[]) {
  const query = args[0]
  if (!query) die('search requires a query argument')

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      type:       { type: 'string', short: 't' },
      source:     { type: 'string', short: 's' },
      'user-id':  { type: 'string', short: 'u' },
      limit:      { type: 'string', short: 'n' },
      'no-cache': { type: 'boolean' }
    },
    strict: false
  })

  const { searchTool } = await getTools()

  const result = await searchTool.search({
    query,
    filters: {
      contentType: values.type ? (values.type as string).split(',') : undefined,
      source: values.source ? (values.source as string).split(',') : undefined,
      userId: values['user-id'] as string | undefined
    },
    options: {
      maxResults: values.limit ? parseInt(values.limit as string, 10) : 10,
      cacheStrategy: (values['no-cache'] as boolean | undefined) ? 'realtime' : 'conservative'
    }
  })

  out(result)
}

// ── Command: ping ─────────────────────────────────────────────────────────────

async function cmdPing() {
  const cfg = buildConfig()

  const checks = await Promise.allSettled([
    (async () => {
      const m = new MongoDBStorage(cfg.mongodb)
      await m.initialize()
      const stats = await m.getStats()
      return { system: 'mongodb', ok: true, stats }
    })(),
    (async () => {
      const n = new Neo4jStorage(cfg.neo4j)
      await n.initialize()
      const stats = await n.getStats()
      return { system: 'neo4j', ok: true, stats }
    })(),
    (async () => {
      const me = new Mem0Storage(cfg.mem0)
      await me.initialize()
      const stats = await me.getStats()
      return { system: 'mem0', ok: true, stats }
    })()
  ])

  const results = checks.map(c =>
    c.status === 'fulfilled' ? c.value : { system: 'unknown', ok: false, error: String((c as any).reason) }
  )

  const allOk = results.every(r => r.ok)
  out({ status: allOk ? 'ok' : 'degraded', systems: results })
  process.exit(allOk ? 0 : 1)
}

// ── Command: route ────────────────────────────────────────────────────────────

async function cmdRoute(args: string[]) {
  const content = args[0]
  if (!content) die('route requires a content argument')

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      type:   { type: 'string', short: 't' },
      source: { type: 'string', short: 's' }
    },
    strict: false
  })

  const router = new IntelligentStorageRouter()
  const decision = router.determineStorage({
    content,
    contentType: values.type as any,
    source: values.source as any
  })

  // Also try Ollama if available
  const cfg = buildConfig()
  const ollama = new OllamaInference(cfg.ollama.baseUrl, cfg.ollama.model)
  let ollamaDecision = null
  if (await ollama.isAvailable()) {
    ollamaDecision = await ollama.classifyStorageTargets(content)
  }

  out({ regex: decision, llm: ollamaDecision })
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage()
    process.exit(0)
  }

  const command = argv[0]
  const rest = argv.slice(1)

  try {
    switch (command) {
      case 'store':  await cmdStore(rest);  break
      case 'search': await cmdSearch(rest); break
      case 'ping':   await cmdPing();       break
      case 'route':  await cmdRoute(rest);  break
      default:
        console.error(`Unknown command: ${command}`)
        usage()
        process.exit(1)
    }
  } finally {
    await teardown()
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
