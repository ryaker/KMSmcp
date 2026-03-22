#!/usr/bin/env node
/**
 * Smoke test: open the existing SparrowDB kms.db and run basic Cypher queries.
 * Does NOT require the full KMS server — hits the NAPI binding directly.
 *
 * Run: node scripts/smoketest-sparrowdb.mjs
 */

import { createRequire } from 'module'
import { join } from 'path'
import { homedir } from 'os'

const require = createRequire(import.meta.url)
const nativePath = join(homedir(), 'Dev/SparrowDB/npm/sparrowdb/index.js')
console.log(`Loading NAPI binding from: ${nativePath}\n`)

let SparrowDB
try {
  ;({ SparrowDB } = require(nativePath))
} catch (e) {
  console.error(`❌ Failed to load NAPI binding: ${e.message}`)
  process.exit(1)
}

const DB_PATH = process.env.SPARROWDB_PATH || join(homedir(), '.kms-sparrowdb')
console.log(`Opening SparrowDB at: ${DB_PATH}\n`)

let db
try {
  db = SparrowDB.open(DB_PATH)
  console.log('✅ DB opened\n')
} catch (e) {
  console.error(`❌ Failed to open DB: ${e.message}`)
  process.exit(1)
}

function run(label, cypher) {
  try {
    const rows = db.execute(cypher)
    const preview = JSON.stringify(rows).substring(0, 160)
    console.log(`✅ ${label} (${rows.length} rows): ${preview}`)
  } catch (e) {
    console.log(`❌ ${label}: ${e.message}`)
  }
  console.log()
}

// 1. Basic counts
run('Total nodes',        'MATCH (n) RETURN count(n) AS cnt')
run('Person nodes',       'MATCH (n:Person) RETURN count(n) AS cnt')
run('Relationship count', 'MATCH ()-[r]->() RETURN count(r) AS cnt')

// 2. String readability — are values truncated or full?
run('First 5 Person names', 'MATCH (n:Person) RETURN n.id, n.name LIMIT 5')

// 3. Specific known node
run('jesse_yaker node',
  'MATCH (n:Person {id:"jesse_yaker"}) RETURN n.id, n.name, n.relationshipToRich')

run('richard_yaker node',
  'MATCH (n:Person {id:"richard_yaker"}) RETURN n.id, n.name, n.relationshipToRich')

// 4. Relationship traversal
run('richard_yaker neighbors',
  'MATCH (n:Person {id:"richard_yaker"})-[r]-(m) RETURN type(r), m.id LIMIT 10')

run('jesse_yaker neighbors',
  'MATCH (n:Person {id:"jesse_yaker"})-[r]-(m) RETURN type(r), m.id LIMIT 5')

// 5. Name resolution simulation (what resolvePersonId does)
run('CONTAINS search for "jesse"',
  'MATCH (n:Person) WHERE toLower(n.name) CONTAINS "jesse" RETURN n.id, n.name LIMIT 5')

run('CONTAINS search for "jennifer"',
  'MATCH (n:Person) WHERE toLower(n.name) CONTAINS "jennifer" RETURN n.id, n.name LIMIT 5')

// 6. Aliases field (used by EntityLinker)
run('Nodes with aliases',
  'MATCH (n:Person) WHERE n.aliases IS NOT NULL RETURN n.id, n.aliases LIMIT 3')

console.log('--- Smoke test complete ---')
