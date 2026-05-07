#!/usr/bin/env node
/**
 * repair-supersede-orphans.mjs
 *
 * One-time scan to find and (with --apply) repair orphan SUPERSEDED chains
 * in MongoDB created by the issue #62 bug.
 *
 * Background: before the supersede() fix, kms_supersede unconditionally
 * required MongoDB.flag to succeed even for entries that lived only in
 * graph+mem0. The flag step succeeded on graph but the new entry was
 * rolled back from MongoDB at the end — leaving the old entry in MongoDB
 * with `flag=SUPERSEDED` but `superseded_by` either NULL or pointing at a
 * now-deleted ID. DG-INV-2 audit found 4/12 such orphans.
 *
 * What this script does:
 *   1. Connect to MongoDB.
 *   2. Find all entries with `flag=SUPERSEDED` AND
 *      (`superseded_by IS NULL` OR `superseded_by` points at an entry that
 *      no longer exists in MongoDB).
 *   3. For each orphan, look in SparrowDB sidecar for an entry whose
 *      `metadata.supersedes` equals the orphan id. If found, that's the
 *      successor — repair MongoDB by setting `superseded_by` to that id.
 *   4. If not found, the new entry was rolled back successfully — log the
 *      orphan as a "true orphan" (chain head intact, just no successor).
 *
 * Modes:
 *   - Default (dry-run): scan and report. Does not write anything.
 *   - --apply: actually persist the repairs.
 *
 * Run:
 *   doppler run --project ry-local --config dev_personal -- \
 *     node scripts/repair-supersede-orphans.mjs            # dry-run
 *
 *   doppler run --project ry-local --config dev_personal -- \
 *     node scripts/repair-supersede-orphans.mjs --apply    # persist fixes
 *
 * Environment:
 *   MONGODB_URI       — full mongo URI (required)
 *   MONGODB_DATABASE  — database name (default: 'kms')
 *   SPARROWDB_PATH    — filesystem path to SparrowDB directory
 *                       (default: ~/.kms-sparrowdb)
 */

import { MongoClient } from 'mongodb'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Args + config
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply')
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose')

// MONGODB_URI is the canonical name; MONGODB_ATLAS_URI is what dev_personal uses.
const mongoUri = process.env.MONGODB_URI || process.env.MONGODB_ATLAS_URI
const mongoDb = process.env.MONGODB_DATABASE || 'unified_kms'

if (!mongoUri) {
  console.error('❌ MONGODB_URI or MONGODB_ATLAS_URI environment variable is required.')
  process.exit(1)
}

const sparrowDbPath = process.env.SPARROWDB_PATH
  ? process.env.SPARROWDB_PATH.replace(/^~/, homedir())
  : join(homedir(), '.kms-sparrowdb')

const sidecarPath = join(sparrowDbPath, 'content-index.json')

// ---------------------------------------------------------------------------
// Load SparrowDB sidecar (content-index.json) — the authoritative store of
// metadata.supersedes forward-links for graph entries.
// ---------------------------------------------------------------------------

function loadSparrowDbSidecar() {
  if (!existsSync(sidecarPath)) {
    console.warn(`⚠️  SparrowDB sidecar not found at ${sidecarPath} — repair will be limited to "true orphan" detection only.`)
    return new Map()
  }

  try {
    const raw = readFileSync(sidecarPath, 'utf8')
    const parsed = JSON.parse(raw)
    // The sidecar is a JSON object: { id: ContentEntry }
    // Build a reverse index: supersedes_id -> successor_id
    const reverseIndex = new Map() // old_id -> new_id (the successor)
    const entries = parsed.entries || parsed
    let entryCount = 0
    for (const id in entries) {
      const e = entries[id]
      entryCount++
      const supersedes = e?.metadata?.supersedes
      if (typeof supersedes === 'string' && supersedes.length > 0) {
        // If multiple successors point at the same old_id, keep the most
        // recent one (latest timestamp wins).
        const existing = reverseIndex.get(supersedes)
        if (!existing || (e.timestamp && existing.timestamp && e.timestamp > existing.timestamp)) {
          reverseIndex.set(supersedes, { id, timestamp: e.timestamp })
        }
      }
    }
    console.log(`📂 Loaded ${entryCount} sidecar entries; found ${reverseIndex.size} forward-links (metadata.supersedes).`)
    return reverseIndex
  } catch (e) {
    console.warn(`⚠️  Could not parse SparrowDB sidecar: ${e.message} — repair will be limited.`)
    return new Map()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🔧 supersede orphan repair scan`)
  console.log(`   Mode:      ${APPLY ? 'APPLY (writing fixes)' : 'DRY-RUN (no writes)'}`)
  console.log(`   Mongo URI: ${mongoUri.replace(/:[^:@]+@/, ':***@')}`)
  console.log(`   Database:  ${mongoDb}`)
  console.log(`   Sidecar:   ${sidecarPath}\n`)

  const reverseIndex = loadSparrowDbSidecar()

  const client = new MongoClient(mongoUri)
  await client.connect()
  const db = client.db(mongoDb)
  const coll = db.collection('unified_knowledge')

  // Find SUPERSEDED entries with missing or dangling superseded_by.
  // Two orphan flavors:
  //   (a) flag=SUPERSEDED AND superseded_by IS NULL/missing
  //   (b) flag=SUPERSEDED AND superseded_by points at an id not in MongoDB
  //
  // Note flavor (b) is informational — for graph-only entries, the successor
  // legitimately doesn't live in MongoDB. We only confirm "true orphan" when
  // the successor is also missing from the SparrowDB sidecar.
  const supersededEntries = await coll
    .find({ flag: 'SUPERSEDED' })
    .project({ id: 1, superseded_by: 1, content: 1, flag_date: 1, flag_note: 1 })
    .toArray()

  console.log(`📊 Total SUPERSEDED entries in MongoDB: ${supersededEntries.length}\n`)

  const orphans = []
  const dangling = []
  const healthyMongo = []      // successor in MongoDB
  const healthyGraphOnly = []  // successor in graph only — the issue #62 pattern, BUT routing-asymmetric is the correct healthy state

  for (const e of supersededEntries) {
    const sb = e.superseded_by

    if (!sb) {
      // Flavor (a): no successor pointer at all.
      const found = reverseIndex.get(e.id)
      if (found) {
        orphans.push({
          old_id: e.id,
          repair_to: found.id,
          flag_date: e.flag_date,
          flag_note: e.flag_note,
          content_preview: (e.content || '').slice(0, 80)
        })
      } else {
        // True orphan — successor was rolled back successfully.
        orphans.push({
          old_id: e.id,
          repair_to: null,
          flag_date: e.flag_date,
          flag_note: e.flag_note,
          content_preview: (e.content || '').slice(0, 80)
        })
      }
    } else {
      // Flavor (b): has a successor pointer. Verify successor exists somewhere.
      const successorInMongo = await coll.findOne({ id: sb }, { projection: { _id: 1 } })
      const successorInGraph = reverseIndex.has(e.id) // reverse-lookup
      if (successorInMongo) {
        healthyMongo.push(e.id)
      } else if (successorInGraph) {
        // Successor exists in graph but not Mongo — that's the EXPECTED state
        // for a successful supersede on a graph-only routed entry post-fix.
        // BEFORE the issue #62 fix this couldn't happen (supersede rolled back),
        // so any such record is a residue of either pre-fix data or hand-edits.
        healthyGraphOnly.push({ old_id: e.id, successor_id: sb })
      } else {
        // Successor pointer points at a ghost — this is unusual. Flag as dangling.
        dangling.push({
          old_id: e.id,
          dangling_pointer: sb,
          flag_date: e.flag_date
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log(`\n=== ORPHAN REPORT ===`)
  console.log(`  Healthy chains (successor in MongoDB):  ${healthyMongo.length}`)
  console.log(`  Healthy chains (successor graph-only):  ${healthyGraphOnly.length}  (routing-asymmetric — flagged by DG-INV-2 but not actually broken)`)
  console.log(`  Repairable orphans:                     ${orphans.filter(o => o.repair_to).length}  (NULL successor pointer + we can find the actual successor in graph)`)
  console.log(`  True orphans:                           ${orphans.filter(o => !o.repair_to).length}  (successor was rolled back; chain head intact, no follow-on)`)
  console.log(`  Dangling pointers:                      ${dangling.length}  (superseded_by points at a ghost id not anywhere)`)
  console.log(``)

  if (healthyGraphOnly.length > 0) {
    console.log(`--- Routing-asymmetric (issue #62 historical pattern) ---`)
    console.log(`These look like orphans only if you're searching MongoDB. The successor lives in SparrowDB / graph.`)
    console.log(`After the issue #62 fix, this is the correct outcome for graph+mem0-only routed entries.`)
    for (const h of healthyGraphOnly) {
      console.log(`  ${h.old_id} → ${h.successor_id}  (successor present in graph)`)
    }
    console.log(``)
  }

  if (orphans.length > 0) {
    console.log(`--- Orphan details ---`)
    for (const o of orphans) {
      const status = o.repair_to ? `→ repair to ${o.repair_to}` : '(true orphan)'
      console.log(`  ${o.old_id} ${status}`)
      console.log(`    flag_date: ${o.flag_date}`)
      console.log(`    flag_note: ${o.flag_note}`)
      console.log(`    preview:   "${o.content_preview}..."`)
      console.log(``)
    }
  }

  if (dangling.length > 0) {
    console.log(`--- Dangling pointer details ---`)
    for (const d of dangling) {
      console.log(`  ${d.old_id} → ${d.dangling_pointer} (not found anywhere)`)
    }
    console.log(``)
  }

  // ---------------------------------------------------------------------------
  // Apply fixes (only if --apply)
  // ---------------------------------------------------------------------------
  if (APPLY) {
    const repairable = orphans.filter(o => o.repair_to)
    console.log(`✏️  Applying ${repairable.length} repair(s) to MongoDB...`)
    let repaired = 0
    for (const o of repairable) {
      const result = await coll.updateOne(
        { id: o.old_id },
        { $set: { superseded_by: o.repair_to, repaired_by: 'repair-supersede-orphans.mjs', repaired_at: new Date() } }
      )
      if (result.modifiedCount > 0) {
        repaired++
        console.log(`  ✓ ${o.old_id} → ${o.repair_to}`)
      } else {
        console.log(`  ✗ ${o.old_id} — not modified (already correct or missing)`)
      }
    }
    console.log(`\n✅ Repaired ${repaired}/${repairable.length} orphans.`)
  } else {
    console.log(`\n💡 Re-run with --apply to persist repairs. (No writes performed in this run.)`)
  }

  await client.close()
}

main().catch(e => {
  console.error(`\n❌ repair-supersede-orphans failed:`, e)
  process.exit(1)
})
