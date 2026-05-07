/**
 * backfill-hnsw-embeddings.ts (DG-BACKFILL, GitHub issue #71)
 *
 * One-shot script to backfill HNSW vectors for existing Knowledge entries in
 * the SparrowDB at $SPARROWDB_PATH (default ~/.kms-sparrowdb-v2/) that lack
 * embeddings (or carry stale `metadata.embedder_id` flags from the pre-PR#69
 * silent-failure path).
 *
 * Why this exists
 * ===============
 * Prior to PR #61 + PR #69, `unified_store` writes attempted to populate the
 * HNSW vector index via `SET k.embedding = [...]` (a Cypher list literal).
 * SparrowDB 0.1.22's parser silently rejected list literals in SET, so the
 * vector never landed in the index even though the surrounding store path
 * succeeded. PR #69 fixed the write path; this script repairs the historical
 * data — ~1216 entries that exist in the SparrowDB sidecar but have no
 * embedding vector in the HNSW index.
 *
 * What it does
 * ============
 *  1. Opens the SparrowDB at SPARROWDB_PATH (read+write — same as the
 *     KMSmcp server uses).
 *  2. Reads the `content-index.json` sidecar.
 *  3. Filters to entries where `metadata.embedder_id` is missing/empty AND
 *     the resumable state file (`~/.kms-backfill-state.json`) hasn't already
 *     marked the id as completed.
 *  4. For each remaining entry, in batches of up to 4 in-flight:
 *       - Generate a 768d embedding via OllamaEmbeddingService.
 *       - Insert the vector via `db.addToVectorIndex(...)`.
 *       - On success: stamp `metadata.embedder_id` + `metadata.embedded_at`
 *         on the in-memory sidecar entry and record the id in the state file.
 *  5. After all entries are processed, persist the sidecar JSON ONCE.
 *  6. Emit a final report.
 *
 * Critical safety
 * ===============
 * SparrowDB 0.1.22 is a single-writer engine. The KMSmcp launchd daemon
 * (`com.ryaker.kms-mcp` on the build server) holds a writer handle on the
 * same database. Running this script concurrently with the daemon will fail
 * to acquire the writer lock; the script aborts with a clear instruction
 * rather than retrying.
 *
 *   BEFORE running:
 *     launchctl bootout gui/501/com.ryaker.kms-mcp
 *
 *   AFTER running:
 *     launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.ryaker.kms-mcp.plist
 *
 * Run
 * ===
 *   # Compile
 *   npm run build
 *
 *   # Dry-run (counts entries that would be backfilled, no writes)
 *   node dist/scripts/backfill-hnsw-embeddings.js --dry-run
 *
 *   # Real run
 *   node dist/scripts/backfill-hnsw-embeddings.js
 *
 *   # Custom paths (env vars):
 *   SPARROWDB_PATH=/custom/db node dist/scripts/backfill-hnsw-embeddings.js
 *   OLLAMA_BASE_URL=http://localhost:11434 node dist/scripts/...
 *
 * Resumable state
 * ===============
 * On every 50 successful inserts (and at exit), the script writes
 * `~/.kms-backfill-state.json`:
 *   {
 *     completed: [...ids],
 *     failed:    [...{id, reason}],
 *     started_at, last_update_at
 *   }
 * On startup, the file is loaded and previously-completed ids are skipped.
 * Delete the file (or the relevant ids inside it) to force a re-run.
 *
 * Exit codes
 * ==========
 *   0 = success (or dry-run)
 *   1 = lock contention (daemon still running) or fatal error (TypeError —
 *       dim mismatch, etc.)
 */

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { execSync } from 'child_process'

import { OllamaEmbeddingService, type EmbeddingService } from '../embedding/EmbeddingService.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of every entry inside content-index.json (mirrors SparrowDBStorage.ContentEntry). */
export interface SidecarEntry {
  id: string
  content: string
  contentType?: string
  source?: string
  userId?: string
  confidence?: number
  timestamp?: string
  metadata?: Record<string, unknown> & {
    embedder_id?: string
    embedded_at?: string
  }
  // Other fields preserved verbatim by the script.
  [key: string]: unknown
}

/** Persistent resumable state — written every 50 successes. */
export interface BackfillState {
  completed: string[]
  failed: Array<{ id: string; reason: string }>
  started_at: string
  last_update_at: string
}

/** Minimal subset of the SparrowDB instance API used by this script. */
export interface SparrowDBLike {
  addToVectorIndex(label: string, property: string, nodeId: string, vector: Float32Array): void
  checkpoint?(): void
}

/** Factory that opens (or fails to open) a SparrowDB at `path`. May be async. */
export type SparrowDBOpener = (path: string) => SparrowDBLike | Promise<SparrowDBLike>

/** Options for the runnable backfill. Everything is injectable so tests can mock. */
export interface BackfillOptions {
  sparrowdbPath: string
  sidecarPath: string
  statePath: string
  embeddingService: EmbeddingService
  openSparrowDB: SparrowDBOpener
  /** Max embeds in flight (default 4). */
  concurrency?: number
  /** Progress / state-flush interval (default 50). */
  flushEvery?: number
  /** Backoff between embed retries in ms (default 2000). */
  retryBackoffMs?: number
  /** When true: do not write to the graph or sidecar. */
  dryRun?: boolean
  /** Sink for log output (default console.log). Useful for tests. */
  log?: (msg: string) => void
  /**
   * Probe that returns true iff the launchd daemon is currently running.
   * SparrowDB 0.1.22's single-writer guarantee is in-process, not OS-level —
   * `SparrowDB.open()` succeeds even when another node process holds writers,
   * so we need this OS-level check as the real gate. Defaults to a launchctl
   * shell-out; tests inject a stub.
   */
  isDaemonRunning?: () => boolean
}

/** Final report emitted at end of run. */
export interface BackfillReport {
  total: number
  succeeded: number
  /** Skipped because they were already in the state file (resume). */
  alreadyCompleted: number
  /** Skipped because graph node was missing (sidecar↔graph drift). */
  graphOrphan: number
  /** Skipped because embed retry exhausted. */
  embedFailed: number
  hnswSizeBefore: number
  hnswSizeAfter: number
  elapsedMs: number
  aborted?: { reason: string }
}

// ---------------------------------------------------------------------------
// Inline semaphore — lighter than pulling p-limit
// ---------------------------------------------------------------------------

/** Concurrency limiter. Lets at most `max` async fns run simultaneously. */
function makeLimiter(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    if (active >= max) return
    const fn = queue.shift()
    if (fn) {
      active++
      fn()
    }
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then(v => { active--; resolve(v); next() })
          .catch(e => { active--; reject(e); next() })
      }
      queue.push(run)
      next()
    })
  }
}

// ---------------------------------------------------------------------------
// State file IO
// ---------------------------------------------------------------------------

function loadState(path: string): BackfillState {
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8')
      const data = JSON.parse(raw) as Partial<BackfillState>
      return {
        completed: Array.isArray(data.completed) ? data.completed : [],
        failed: Array.isArray(data.failed) ? data.failed : [],
        started_at: typeof data.started_at === 'string' ? data.started_at : new Date().toISOString(),
        last_update_at: typeof data.last_update_at === 'string' ? data.last_update_at : new Date().toISOString(),
      }
    } catch (e) {
      // Corrupt state file — start fresh. The original is left intact for the
      // operator to inspect; we write to the same path, overwriting on success.
      const now = new Date().toISOString()
      return { completed: [], failed: [], started_at: now, last_update_at: now }
    }
  }
  const now = new Date().toISOString()
  return { completed: [], failed: [], started_at: now, last_update_at: now }
}

function saveState(path: string, state: BackfillState): void {
  state.last_update_at = new Date().toISOString()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Sidecar IO — mirrors SparrowDBStorage._loadSidecar/_saveSidecar shape
// (object keyed by id).
// ---------------------------------------------------------------------------

function loadSidecar(path: string): Map<string, SidecarEntry> {
  const out = new Map<string, SidecarEntry>()
  if (!existsSync(path)) return out
  const raw = readFileSync(path, 'utf8')
  const data = JSON.parse(raw)

  // Sidecar format is keyed by id (object). Tolerate the array form just in
  // case a future export emits one.
  if (Array.isArray(data)) {
    for (const e of data) {
      if (e && typeof e.id === 'string') out.set(e.id, e as SidecarEntry)
    }
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, SidecarEntry>)) {
      if (v && typeof v.id === 'string') out.set(k, v)
    }
  }
  return out
}

function saveSidecar(path: string, entries: Map<string, SidecarEntry>): void {
  const obj: Record<string, SidecarEntry> = {}
  for (const [k, v] of entries) obj[k] = v
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// File-size helper for the report
// ---------------------------------------------------------------------------

function fileSizeOrZero(p: string): number {
  try {
    return existsSync(p) ? statSync(p).size : 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// "Needs backfill?" predicate — single source of truth used by both the
// filtering pass and the resume-skip check.
// ---------------------------------------------------------------------------

export function entryNeedsBackfill(entry: SidecarEntry): boolean {
  const v = entry.metadata?.embedder_id
  return typeof v !== 'string' || v.length === 0
}

// ---------------------------------------------------------------------------
// Embed-with-retry helper. Returns null on terminal failure.
// ---------------------------------------------------------------------------

async function embedWithRetry(
  svc: EmbeddingService,
  text: string,
  retryBackoffMs: number,
  log: (msg: string) => void,
  id: string,
): Promise<{ vec: Float32Array; embedderId: string } | { error: string }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const vec = await svc.embed(text)
      return { vec, embedderId: svc.embedderId }
    } catch (e) {
      lastError = e
      if (attempt === 0) {
        log(`  [retry] ${id}: embed failed (${e instanceof Error ? e.message : String(e)}) — backing off ${retryBackoffMs}ms`)
        await new Promise(r => setTimeout(r, retryBackoffMs))
      }
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  return { error: `embed failed after retry: ${reason}` }
}

// ---------------------------------------------------------------------------
// Core runnable. Pure (everything injected) so it's directly testable.
// ---------------------------------------------------------------------------

export async function runBackfill(opts: BackfillOptions): Promise<BackfillReport> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const concurrency = opts.concurrency ?? 4
  const flushEvery = opts.flushEvery ?? 50
  const retryBackoffMs = opts.retryBackoffMs ?? 2000
  const startTime = Date.now()
  const hnswPath = join(opts.sparrowdbPath, 'vector_indexes', 'hnsw_Knowledge_embedding.bin')
  const hnswSizeBefore = fileSizeOrZero(hnswPath)

  // ----- Lock acquisition first ------------------------------------------------
  // Two-step gate:
  //   1. OS-level: is the launchd daemon running? SparrowDB 0.1.22's
  //      single-writer guarantee is process-local, so two writers DO NOT
  //      conflict at the binding level — corruption is silent. The
  //      launchctl probe is the real gate.
  //   2. Binding-level: did SparrowDB.open() throw? Catches the rare case
  //      where the directory itself is corrupt or unreadable.
  // Either failure prints the same operator instruction and aborts.
  const failOpen = (reason: string, detail: string): BackfillReport => {
    log('')
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    log('  STOP THE LAUNCHD DAEMON FIRST')
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    log('')
    log(`  ${reason}`)
    log(`    ${detail}`)
    log('')
    log('  SparrowDB 0.1.22 is single-writer. The KMSmcp daemon')
    log('  must be stopped before this script can safely write')
    log('  to the HNSW index. Run:')
    log('')
    log('    launchctl bootout gui/501/com.ryaker.kms-mcp')
    log('')
    log('  …then re-run this script. After it finishes:')
    log('')
    log('    launchctl bootstrap gui/501 \\')
    log('      ~/Library/LaunchAgents/com.ryaker.kms-mcp.plist')
    log('')
    return {
      total: 0,
      succeeded: 0,
      alreadyCompleted: 0,
      graphOrphan: 0,
      embedFailed: 0,
      hnswSizeBefore,
      hnswSizeAfter: hnswSizeBefore,
      elapsedMs: Date.now() - startTime,
      aborted: { reason: `lock_contention: ${detail}` },
    }
  }

  // OS-level daemon check. Skip in dry-run since we don't write.
  const daemonProbe = opts.isDaemonRunning ?? defaultIsDaemonRunning
  if (!opts.dryRun && daemonProbe()) {
    return failOpen('Daemon (com.ryaker.kms-mcp) is currently running:', 'launchctl reports active state')
  }

  let db: SparrowDBLike
  try {
    db = await opts.openSparrowDB(opts.sparrowdbPath)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return failOpen('Could not open SparrowDB at:', `${opts.sparrowdbPath} — ${msg}`)
  }

  // ----- Load sidecar + state -------------------------------------------------
  const sidecar = loadSidecar(opts.sidecarPath)
  log(`📒 Loaded ${sidecar.size} sidecar entries from ${opts.sidecarPath}`)

  const state = loadState(opts.statePath)
  const completedSet = new Set(state.completed)
  log(`📁 State file: ${state.completed.length} previously completed, ${state.failed.length} previously failed`)

  // ----- Build work list ------------------------------------------------------
  const candidates: SidecarEntry[] = []
  let alreadyCompleted = 0
  for (const entry of sidecar.values()) {
    if (!entryNeedsBackfill(entry)) continue
    if (completedSet.has(entry.id)) {
      alreadyCompleted++
      continue
    }
    candidates.push(entry)
  }

  const total = candidates.length
  log(`🎯 ${total} entries need backfill (skipped ${alreadyCompleted} already-completed from state, ${sidecar.size - total - alreadyCompleted} already have embedder_id)`)

  if (total === 0) {
    log('✅ Nothing to do.')
    return {
      total: 0,
      succeeded: 0,
      alreadyCompleted,
      graphOrphan: 0,
      embedFailed: 0,
      hnswSizeBefore,
      hnswSizeAfter: fileSizeOrZero(hnswPath),
      elapsedMs: Date.now() - startTime,
    }
  }

  if (opts.dryRun) {
    log(`🟡 Dry-run: would backfill ${total} entries. No writes performed.`)
    return {
      total,
      succeeded: 0,
      alreadyCompleted,
      graphOrphan: 0,
      embedFailed: 0,
      hnswSizeBefore,
      hnswSizeAfter: hnswSizeBefore,
      elapsedMs: Date.now() - startTime,
    }
  }

  // ----- Process with concurrency limit ---------------------------------------
  const limit = makeLimiter(concurrency)
  let succeeded = 0
  let graphOrphan = 0
  let embedFailed = 0
  let processedSinceFlush = 0
  // Abort-on-fatal hook: TypeError from addToVectorIndex (dimension mismatch).
  let fatalError: Error | null = null

  const tasks = candidates.map(entry =>
    limit(async () => {
      if (fatalError) return // short-circuit remaining queue after abort

      const t0 = Date.now()

      // 1. Embed (with one retry).
      const embedResult = await embedWithRetry(opts.embeddingService, entry.content, retryBackoffMs, log, entry.id)
      if ('error' in embedResult) {
        embedFailed++
        state.failed.push({ id: entry.id, reason: embedResult.error })
        log(`  ❌ ${entry.id}: ${embedResult.error}`)
        return
      }

      // 2. Insert into HNSW.
      try {
        db.addToVectorIndex('Knowledge', 'embedding', entry.id, embedResult.vec)
      } catch (e) {
        if (e instanceof TypeError) {
          // Dimension mismatch is fundamental — abort the script.
          fatalError = e
          log(`  💥 FATAL TypeError on ${entry.id}: ${e.message} — aborting`)
          return
        }
        const msg = e instanceof Error ? e.message : String(e)
        // Most common: RangeError "no node with id" — graph orphan, log+skip.
        if (e instanceof RangeError && /no node with id/i.test(msg)) {
          graphOrphan++
          state.failed.push({ id: entry.id, reason: `graph_orphan: ${msg}` })
          log(`  ⚠️  ${entry.id}: graph orphan (no Knowledge node) — skipping`)
          return
        }
        // Any other error is recorded and skipped (NOT aborted) — keeps the
        // backfill making forward progress on a partially-corrupt graph.
        embedFailed++
        state.failed.push({ id: entry.id, reason: `addToVectorIndex_failed: ${msg}` })
        log(`  ❌ ${entry.id}: addToVectorIndex failed: ${msg}`)
        return
      }

      // 3. Stamp metadata + persist progress (in-memory only).
      const e = sidecar.get(entry.id)
      if (e) {
        e.metadata = {
          ...(e.metadata || {}),
          embedder_id: embedResult.embedderId,
          embedded_at: new Date().toISOString(),
        }
        sidecar.set(entry.id, e)
      }
      state.completed.push(entry.id)
      succeeded++
      processedSinceFlush++

      // 4. Periodic state flush + progress log.
      if (processedSinceFlush >= flushEvery) {
        processedSinceFlush = 0
        saveState(opts.statePath, state)
        const done = succeeded + graphOrphan + embedFailed
        const avgMsPerEntry = (Date.now() - startTime) / Math.max(done, 1)
        const remaining = total - done
        const etaMin = Math.round((remaining * avgMsPerEntry) / 60_000)
        log(`📈 ${done}/${total} done, ETA ${etaMin}min, last_id=${entry.id} (took ${Date.now() - t0}ms)`)
      }
    }),
  )

  // Wait for everything (or fatalError to propagate).
  await Promise.allSettled(tasks)

  // ----- Final flush ----------------------------------------------------------
  saveState(opts.statePath, state)

  if (fatalError) {
    log(`\n💥 Aborted due to fatal error: ${fatalError.message}`)
    log(`   ${succeeded} embeddings persisted before abort. State file updated.`)
    return {
      total,
      succeeded,
      alreadyCompleted,
      graphOrphan,
      embedFailed,
      hnswSizeBefore,
      hnswSizeAfter: fileSizeOrZero(hnswPath),
      elapsedMs: Date.now() - startTime,
      aborted: { reason: `fatal_typeerror: ${fatalError.message}` },
    }
  }

  // Persist the sidecar ONCE — see comment in storeEmbedding (PR #69) about
  // the cost of repeated sidecar writes.
  if (succeeded > 0) {
    saveSidecar(opts.sidecarPath, sidecar)
    log(`💾 Sidecar persisted (${sidecar.size} entries).`)
  } else {
    log(`(no successes — sidecar unchanged)`)
  }

  // Best-effort checkpoint so the HNSW write hits disk.
  try {
    db.checkpoint?.()
  } catch (e) {
    log(`⚠️  checkpoint failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return {
    total,
    succeeded,
    alreadyCompleted,
    graphOrphan,
    embedFailed,
    hnswSizeBefore,
    hnswSizeAfter: fileSizeOrZero(hnswPath),
    elapsedMs: Date.now() - startTime,
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

/**
 * Default opener that dynamically imports the `sparrowdb` npm package and
 * calls `SparrowDB.open()`. Dynamic import keeps the native binding off the
 * test path (the binding crashes when not on the platform it was built for)
 * and keeps `import.meta.url`-based createRequire out of this module so
 * Jest can load the file directly without ESM-loader gymnastics.
 *
 * The literal name is built from a runtime variable to keep TypeScript from
 * resolving sparrowdb's index.d.ts during compilation — that file has
 * pre-PR-#410 JSDoc comments containing nested `/** ... *\/` blocks inside
 * markdown code fences which trip the TS parser. The actual import still
 * succeeds at runtime against the same package.
 */
async function defaultOpener(path: string): Promise<SparrowDBLike> {
  const pkg = ['sparrow', 'db'].join('')  // == 'sparrowdb', opaque to TS resolver
  const mod = await import(pkg)
  // The CJS-exported native binding lands on `mod.default` under Node's ESM
  // interop. Some bundlers also expose it directly on `mod`. Prefer default,
  // fall back to top-level for forward compatibility.
  type SparrowDBLib = { SparrowDB: { open(p: string): SparrowDBLike } }
  const lib = ((mod as { default?: unknown }).default ?? mod) as SparrowDBLib
  return lib.SparrowDB.open(path)
}

/**
 * Default daemon probe: shells out to `launchctl print` for the per-user
 * service. Returns true iff launchctl reports the service exists AND is
 * not in 'not running' state.
 *
 * Exits non-zero on:
 *   - Service not loaded (label unknown)
 *   - launchctl unavailable (non-macOS hosts)
 * Both cases are interpreted as "not running" — false. The script then
 * proceeds; in the rare case the daemon is running under a different mech
 * (manual `node dist/index.js`), the operator can still pass
 * `KMS_BACKFILL_FORCE=1` to bypass.
 */
function defaultIsDaemonRunning(): boolean {
  if (process.env.KMS_BACKFILL_FORCE === '1') return false
  try {
    const uid = process.getuid?.() ?? 501
    const out = execSync(
      `launchctl print "gui/${uid}/com.ryaker.kms-mcp"`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString()
    // launchctl prints `state = running` (or `not running`). Treat anything
    // other than explicit not-running / pid=0 as live.
    if (/state\s*=\s*not running/i.test(out)) return false
    if (/state\s*=\s*running/i.test(out)) return true
    // Older macOS: pid=0 means the agent is loaded but idle/stopped.
    if (/pid\s*=\s*0\b/.test(out)) return false
    return true  // loaded + has a pid → running
  } catch {
    // launchctl exited non-zero → service not loaded → not running.
    return false
  }
}

async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run')

  const sparrowdbPath = process.env.SPARROWDB_PATH || join(homedir(), '.kms-sparrowdb-v2')
  const sidecarPath = join(sparrowdbPath, 'content-index.json')
  const statePath = process.env.KMS_BACKFILL_STATE_FILE || join(homedir(), '.kms-backfill-state.json')

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  KMS HNSW Embedding Backfill (DG-BACKFILL, issue #71)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log(`  SparrowDB:  ${sparrowdbPath}`)
  console.log(`  Sidecar:    ${sidecarPath}`)
  console.log(`  State file: ${statePath}`)
  console.log(`  Mode:       ${dryRun ? 'DRY-RUN' : 'WRITE'}`)
  console.log('')

  const embeddingService = new OllamaEmbeddingService({
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  })

  // Pre-flight: confirm Ollama is reachable. If not, abort early so we
  // don't open the SparrowDB writer for nothing.
  if (!dryRun) {
    const available = await embeddingService.isAvailable()
    if (!available) {
      console.error('❌ Ollama is not reachable at ' + (process.env.OLLAMA_BASE_URL || 'http://localhost:11434'))
      console.error('   Start it with `ollama serve` and ensure nomic-embed-text is pulled:')
      console.error('     ollama pull nomic-embed-text')
      return 1
    }
  }

  const report = await runBackfill({
    sparrowdbPath,
    sidecarPath,
    statePath,
    embeddingService,
    openSparrowDB: defaultOpener,
    dryRun,
  })

  // Print final report
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Final report')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log(`  Total processed:           ${report.total}`)
  console.log(`  Succeeded:                 ${report.succeeded}`)
  console.log(`  Skipped (already done):    ${report.alreadyCompleted}`)
  console.log(`  Skipped (graph orphan):    ${report.graphOrphan}`)
  console.log(`  Failed (embed errors):     ${report.embedFailed}`)
  console.log(`  HNSW size before:          ${report.hnswSizeBefore} bytes`)
  console.log(`  HNSW size after:           ${report.hnswSizeAfter} bytes (Δ ${report.hnswSizeAfter - report.hnswSizeBefore})`)
  console.log(`  Elapsed:                   ${(report.elapsedMs / 1000).toFixed(1)}s`)
  if (report.aborted) {
    console.log(`  Aborted:                   ${report.aborted.reason}`)
  }
  console.log('')

  if (report.aborted) return 1
  return 0
}

// Detect CLI invocation. The compiled file lives at dist/scripts/...; we run
// only when this module is the entrypoint, not when the test imports it.
const isCli = (() => {
  try {
    const argv1 = process.argv[1] ?? ''
    return argv1.includes('backfill-hnsw-embeddings')
  } catch {
    return false
  }
})()

if (isCli) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => {
      console.error('💥 Uncaught error:', err)
      process.exit(1)
    })
}
