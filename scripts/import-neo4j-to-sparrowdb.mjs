#!/usr/bin/env node
/**
 * import-neo4j-to-sparrowdb.mjs
 *
 * Exports the full KMS graph from Neo4j Aura and imports it into SparrowDB
 * via the NAPI binding, correctly building the content sidecar.
 *
 * Run:
 *   SPARROWDB_PATH=~/.kms-sparrowdb \
 *   doppler run --project ry-local --config dev_personal -- \
 *     node scripts/import-neo4j-to-sparrowdb.mjs
 *
 * Environment variables:
 *   NEO4J_AURA_URI          — bolt URI to Neo4j Aura
 *   NEO4J_AURA_USERNAME     — Neo4j username
 *   NEO4J_AURA_PASSWORD     — Neo4j password
 *   NEO4J_AURA_DATABASE     — Neo4j database name (e.g. "neo4j")
 *   SPARROWDB_PATH          — filesystem path to SparrowDB directory
 *                             (default: ~/.kms-sparrowdb)
 */

import neo4j from 'neo4j-driver'
import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const dbPath = process.env.SPARROWDB_PATH
  ? process.env.SPARROWDB_PATH.replace(/^~/, homedir())
  : join(homedir(), '.kms-sparrowdb')

const sidecarPath = join(dbPath, 'content-index.json')

// ---------------------------------------------------------------------------
// Load SparrowDB NAPI binding
// ---------------------------------------------------------------------------

function loadSparrowDB() {
  const require = createRequire(import.meta.url)
  // Use the npm wrapper (index.js) which handles the platform-specific .node selection.
  const bindingPath = join(homedir(), 'Dev', 'SparrowDB', 'npm', 'sparrowdb', 'index.js')
  if (!existsSync(bindingPath)) {
    throw new Error(
      `SparrowDB binding not found at: ${bindingPath}\n` +
      'Run: cargo build --release -p sparrowdb-node  in ~/Dev/SparrowDB'
    )
  }
  return require(bindingPath)
}

// ---------------------------------------------------------------------------
// Cypher string escape helpers
// SparrowDB execute() has no parameter binding — values must be embedded.
// ---------------------------------------------------------------------------

/** Escape a string for embedding inside single-quoted Cypher literals. */
function esc(s) {
  return s
    .replace(/\\/g, '\\\\')   // backslashes first
    .replace(/'/g, "\\'")     // single quotes
    .replace(/\n/g, '\\n')    // newlines
    .replace(/\r/g, '\\r')    // carriage returns
}

function cypherStr(s) {
  return `'${esc(s)}'`
}

// ---------------------------------------------------------------------------
// Build a Cypher property map string from a plain object.
// - Skips null/undefined values
// - Truncates strings to 5000 chars (full content goes into sidecar)
// - Stores arrays as JSON strings (SparrowDB has no native array type)
// - Stores numbers as unquoted literals
// - Stores booleans as unquoted literals
// ---------------------------------------------------------------------------

function buildPropMap(props) {
  const parts = []
  for (const [key, rawVal] of Object.entries(props)) {
    if (rawVal === null || rawVal === undefined) continue

    // Sanitise property key (alphanum + underscore only)
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_')

    if (typeof rawVal === 'string') {
      const truncated = rawVal.slice(0, 5000)
      parts.push(`${safeKey}: ${cypherStr(truncated)}`)
    } else if (typeof rawVal === 'number') {
      // Guard against NaN/Infinity
      const safe = isFinite(rawVal) ? rawVal : 0
      parts.push(`${safeKey}: ${safe}`)
    } else if (typeof rawVal === 'boolean') {
      parts.push(`${safeKey}: ${rawVal}`)
    } else if (Array.isArray(rawVal)) {
      const json = JSON.stringify(rawVal).slice(0, 5000)
      parts.push(`${safeKey}: ${cypherStr(json)}`)
    } else if (typeof rawVal === 'object') {
      // neo4j Integer / Date / Point — convert to string
      const str = String(rawVal)
      parts.push(`${safeKey}: ${cypherStr(str.slice(0, 5000))}`)
    }
    // Anything else: skip
  }
  return `{ ${parts.join(', ')} }`
}

// ---------------------------------------------------------------------------
// Build the content sidecar entry for a node.
// This mirrors the ContentEntry interface in SparrowDBStorage.ts exactly:
//   { id, content, contentType, source, userId, confidence, timestamp, metadata }
// ---------------------------------------------------------------------------

function buildSidecarEntry(nodeId, props, labels) {
  // Derive a human-readable "content" string from available properties.
  // Prefer name > description > notes > headline > id.
  const content = [
    props.name,
    props.description,
    props.notes,
    props.headline,
    props.content,
    props.text,
  ]
    .filter(v => typeof v === 'string' && v.trim().length > 0)
    .join(' — ')
    || nodeId

  return {
    id: nodeId,
    content,
    contentType: props.contentType || labels[0] || 'fact',
    source: props.source || 'neo4j-import',
    userId: props.userId || props.user_id || '',
    confidence: typeof props.confidence === 'number' ? props.confidence : 0.8,
    timestamp: props.timestamp || props.createdAt || new Date().toISOString(),
    metadata: Object.fromEntries(
      Object.entries(props).filter(([k]) =>
        !['id', 'name', 'description', 'content', 'contentType', 'source',
          'userId', 'confidence', 'timestamp', 'createdAt'].includes(k)
      )
    )
  }
}

// ---------------------------------------------------------------------------
// Coerce a neo4j record field to a plain JS value
// ---------------------------------------------------------------------------

function coerce(val) {
  if (val === null || val === undefined) return null
  // neo4j.Integer
  if (neo4j.isInt(val)) return val.toNumber()
  // neo4j Point
  if (val instanceof neo4j.types.Point) return `Point(${val.x},${val.y})`
  // neo4j Date/DateTime/Duration
  if (val && typeof val === 'object' && typeof val.toString === 'function' &&
      !(val instanceof Array) && val.constructor && val.constructor.name !== 'Object') {
    return val.toString()
  }
  // Array — recurse
  if (Array.isArray(val)) return val.map(coerce)
  // Plain object — recurse
  if (typeof val === 'object') {
    return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, coerce(v)]))
  }
  return val
}

// ---------------------------------------------------------------------------
// Flatten neo4j node properties to plain JS object
// ---------------------------------------------------------------------------

function flattenNodeProps(record, alias) {
  const node = record.get(alias)
  const props = {}
  for (const [key, val] of Object.entries(node.properties)) {
    props[key] = coerce(val)
  }
  return { props, labels: node.labels, elementId: node.elementId }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('=== Neo4j → SparrowDB Import ===')
console.log(`SparrowDB path: ${dbPath}`)
console.log(`Sidecar path:   ${sidecarPath}`)
console.log()

// ---- Connect to Neo4j ----

const neo4jUri      = process.env.NEO4J_AURA_URI
const neo4jUser     = process.env.NEO4J_AURA_USERNAME
const neo4jPassword = process.env.NEO4J_AURA_PASSWORD
const neo4jDatabase = process.env.NEO4J_AURA_DATABASE

if (!neo4jUri || !neo4jUser || !neo4jPassword) {
  console.error('ERROR: NEO4J_AURA_URI, NEO4J_AURA_USERNAME, NEO4J_AURA_PASSWORD must be set.')
  process.exit(1)
}

console.log(`Connecting to Neo4j: ${neo4jUri} (db=${neo4jDatabase || 'default'})`)
const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword))
const sess = driver.session({ database: neo4jDatabase || undefined })

// ---- Open SparrowDB ----

if (!existsSync(dbPath)) {
  mkdirSync(dbPath, { recursive: true })
  console.log(`Created SparrowDB directory: ${dbPath}`)
}

console.log('Loading SparrowDB NAPI binding…')
const { SparrowDB } = loadSparrowDB()
const db = SparrowDB.open(dbPath)
console.log('SparrowDB opened.\n')

// ---- Export nodes from Neo4j ----

console.log('Exporting nodes from Neo4j…')
const nodeResult = await sess.run(`MATCH (n) RETURN n`)
const nodeRecords = nodeResult.records
console.log(`  Found ${nodeRecords.length} nodes.\n`)

// Content sidecar — keyed by node elementId (stable across the import).
// We also maintain an elementId → nodeId mapping to resolve relationships.
const contentIndex = {}           // nodeId (our prop) → ContentEntry
const elementIdToNodeId = {}      // Neo4j elementId → node id property

let nodeSuccessCount = 0
let nodeErrorCount = 0

for (const record of nodeRecords) {
  const { props, labels, elementId } = flattenNodeProps(record, 'n')

  // Every node must have an 'id' property — skip if missing.
  const nodeId = props.id
  if (!nodeId) {
    console.warn(`  SKIP node ${elementId} — no 'id' property. Labels: ${labels.join(', ')}`)
    nodeErrorCount++
    continue
  }

  elementIdToNodeId[elementId] = nodeId

  // Build primary label (first one).
  const primaryLabel = labels[0] || 'Node'

  // Build prop map for Cypher (all props, strings truncated).
  const propMap = buildPropMap(props)

  // Build the label string (support multiple labels).
  const labelStr = labels.map(l => `:${l}`).join('')

  try {
    // Delete existing node (upsert via DELETE+CREATE — MERGE+SET unsupported in SparrowDB).
    try {
      db.execute(`MATCH (n${labelStr} {id: ${cypherStr(nodeId)}}) DELETE n`)
    } catch {
      // May not exist — fine.
    }

    // Create node.
    db.execute(`CREATE (n${labelStr} ${propMap})`)

    // Build and store sidecar entry.
    const entry = buildSidecarEntry(nodeId, props, labels)
    contentIndex[nodeId] = entry

    nodeSuccessCount++
    if (nodeSuccessCount % 50 === 0) {
      console.log(`  ... ${nodeSuccessCount} nodes imported`)
    }
  } catch (error) {
    console.error(`  ERROR importing node ${nodeId} (${labels.join(', ')}): ${error.message}`)
    nodeErrorCount++
    // Continue with next node — do not abort.
  }
}

console.log(`\nNodes: ${nodeSuccessCount} imported, ${nodeErrorCount} skipped/errored.\n`)

// ---- Export relationships from Neo4j ----

console.log('Exporting relationships from Neo4j…')
const relResult = await sess.run(`MATCH (a)-[r]->(b) RETURN a, r, b`)
const relRecords = relResult.records
console.log(`  Found ${relRecords.length} relationships.\n`)

let relSuccessCount = 0
let relErrorCount = 0

for (const record of relRecords) {
  const startNode = record.get('a')
  const rel       = record.get('r')
  const endNode   = record.get('b')

  // Resolve node IDs from elementId map.
  const startNodeId = elementIdToNodeId[startNode.elementId]
  const endNodeId   = elementIdToNodeId[endNode.elementId]

  if (!startNodeId || !endNodeId) {
    console.warn(
      `  SKIP relationship ${rel.type} — could not resolve node IDs. ` +
      `start=${startNode.elementId} end=${endNode.elementId}`
    )
    relErrorCount++
    continue
  }

  // Sanitise relationship type for Cypher.
  const relType = rel.type.toUpperCase().replace(/[^A-Z0-9_]/g, '_')

  // Find the labels of start and end nodes (needed for MATCH).
  const startLabels = startNode.labels
  const endLabels   = endNode.labels
  const startLabel  = startLabels[0] || 'Node'
  const endLabel    = endLabels[0] || 'Node'

  try {
    db.execute(
      `MATCH (a:${startLabel} {id: ${cypherStr(startNodeId)}}), ` +
      `(b:${endLabel} {id: ${cypherStr(endNodeId)}}) ` +
      `CREATE (a)-[:${relType}]->(b)`
    )
    relSuccessCount++
    if (relSuccessCount % 100 === 0) {
      console.log(`  ... ${relSuccessCount} relationships imported`)
    }
  } catch (error) {
    console.error(
      `  ERROR importing relationship ${relType} ` +
      `(${startNodeId} → ${endNodeId}): ${error.message}`
    )
    relErrorCount++
    // Continue — do not abort.
  }
}

console.log(`\nRelationships: ${relSuccessCount} imported, ${relErrorCount} skipped/errored.\n`)

// ---- Write content sidecar ----

console.log(`Writing content sidecar to: ${sidecarPath}`)
writeFileSync(sidecarPath, JSON.stringify(contentIndex, null, 2), 'utf8')
console.log(`  ${Object.keys(contentIndex).length} entries written to content-index.json\n`)

// ---- Checkpoint SparrowDB ----

console.log('Checkpointing SparrowDB…')
db.checkpoint()
console.log('Checkpoint complete.\n')

// ---- Verification query ----

console.log('Verification:')
try {
  const verify = db.execute(`MATCH (n:Person) RETURN count(n)`)
  const personCount = verify.rows[0]?.['count(n)'] ?? 0
  console.log(`  Person nodes in SparrowDB: ${personCount}`)
} catch (error) {
  console.warn(`  Verification query failed: ${error.message}`)
}

// ---- Summary ----

console.log('\n=== Import Complete ===')
console.log(`  Nodes imported:         ${nodeSuccessCount}`)
console.log(`  Nodes skipped/errored:  ${nodeErrorCount}`)
console.log(`  Rels imported:          ${relSuccessCount}`)
console.log(`  Rels skipped/errored:   ${relErrorCount}`)
console.log(`  Sidecar entries:        ${Object.keys(contentIndex).length}`)
console.log(`  SparrowDB path:         ${dbPath}`)
console.log(`  Sidecar path:           ${sidecarPath}`)

// ---- Close Neo4j ----

await sess.close()
await driver.close()
