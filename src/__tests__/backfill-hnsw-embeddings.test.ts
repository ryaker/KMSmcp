/**
 * Tests for the DG-BACKFILL one-shot script (GitHub issue #71).
 *
 * The script under test is pure: everything (SparrowDB opener, embedding
 * service, file paths) is injectable via BackfillOptions, so these tests run
 * entirely without a live SparrowDB or Ollama.
 *
 * Coverage:
 *   - Empty input → exit-clean, no writes.
 *   - State-file resume: ids in state.completed are skipped on second run.
 *   - Concurrency cap: at most N embeds in flight at once.
 *   - RangeError "no node with id" → logged + skipped, not aborted.
 *   - TypeError → aborted (report.aborted set, partial successes preserved).
 *   - Successful run → metadata.embedder_id + metadata.embedded_at written.
 *   - Lock contention (open throws) → "STOP THE LAUNCHD DAEMON" + abort.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  runBackfill,
  entryNeedsBackfill,
  type SidecarEntry,
  type SparrowDBLike,
  type SparrowDBOpener,
  type BackfillOptions,
} from '../scripts/backfill-hnsw-embeddings.js'
import type { EmbeddingService } from '../embedding/EmbeddingService.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'kms-backfill-test-'))
}

function makeSidecar(entries: SidecarEntry[]): Record<string, SidecarEntry> {
  const out: Record<string, SidecarEntry> = {}
  for (const e of entries) out[e.id] = e
  return out
}

function makeEntry(id: string, opts: Partial<SidecarEntry> = {}): SidecarEntry {
  return {
    id,
    content: `content for ${id}`,
    contentType: 'fact',
    source: 'test',
    userId: 'richard_yaker',
    confidence: 0.8,
    timestamp: '2026-04-01T00:00:00.000Z',
    metadata: {},
    ...opts,
  }
}

/** A Float32Array filled with deterministic values from `seed`. */
function fakeVec(seed: number): Float32Array {
  const v = new Float32Array(768)
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed + i)
  return v
}

/** Mock EmbeddingService with optional delay + counters. */
function makeMockEmbedder(opts: {
  delayMs?: number
  embedderId?: string
  /** Optional override: throw on this id. */
  failOn?: Set<string>
  /** Visible to test for concurrency assertions. */
  inFlight?: { peak: number; current: number }
}): EmbeddingService & { calls: string[] } {
  const calls: string[] = []
  const inFlight = opts.inFlight ?? { peak: 0, current: 0 }
  return {
    embedderId: opts.embedderId || 'nomic-embed-text:v1',
    dimensions: 768,
    calls,
    isAvailable: async () => true,
    embed: async (text: string) => {
      calls.push(text)
      inFlight.current++
      if (inFlight.current > inFlight.peak) inFlight.peak = inFlight.current
      try {
        if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
        if (opts.failOn?.has(text)) {
          throw new Error(`mock embed failure for ${text}`)
        }
        return fakeVec(text.length)
      } finally {
        inFlight.current--
      }
    },
  }
}

/** Mock SparrowDB. Records every addToVectorIndex call. */
function makeMockDb(opts: {
  failWith?: Map<string, Error>
  recorded?: Array<{ id: string; vec: Float32Array }>
} = {}): SparrowDBLike & { calls: Array<{ id: string; vec: Float32Array }> } {
  const calls = opts.recorded ?? []
  return {
    calls,
    addToVectorIndex: (label, prop, nodeId, vec) => {
      const err = opts.failWith?.get(nodeId)
      if (err) throw err
      calls.push({ id: nodeId, vec })
    },
    checkpoint: () => {},
  }
}

function buildOpts(
  tmp: string,
  sidecarObj: Record<string, SidecarEntry>,
  overrides: Partial<BackfillOptions> = {},
): BackfillOptions {
  const sparrowdbPath = join(tmp, 'sparrowdb')
  const sidecarPath = join(tmp, 'content-index.json')
  const statePath = join(tmp, 'state.json')
  writeFileSync(sidecarPath, JSON.stringify(sidecarObj, null, 2), 'utf8')

  const defaultDb = makeMockDb()
  const opener: SparrowDBOpener = () => defaultDb
  const embeddingService = makeMockEmbedder({})

  return {
    sparrowdbPath,
    sidecarPath,
    statePath,
    embeddingService,
    openSparrowDB: opener,
    concurrency: 4,
    flushEvery: 50,
    retryBackoffMs: 5,
    log: () => {},
    // Default: pretend daemon is NOT running so test runs on the actual
    // build server (where the daemon may be live) don't get gated. Tests
    // that exercise the daemon-detection path override this explicitly.
    isDaemonRunning: () => false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfill-hnsw-embeddings', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
  })

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
  })

  // -------------------------------------------------------------------------

  describe('entryNeedsBackfill', () => {
    it('returns true when metadata.embedder_id is missing', () => {
      expect(entryNeedsBackfill(makeEntry('a'))).toBe(true)
    })
    it('returns false when metadata.embedder_id is set', () => {
      expect(entryNeedsBackfill(makeEntry('a', {
        metadata: { embedder_id: 'nomic-embed-text:v1' },
      }))).toBe(false)
    })
    it('returns true for empty-string embedder_id (treated as missing)', () => {
      expect(entryNeedsBackfill(makeEntry('a', { metadata: { embedder_id: '' } }))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------

  it('empty input → graceful exit, exit code 0', async () => {
    const opts = buildOpts(tmp, {})
    const report = await runBackfill(opts)

    expect(report.total).toBe(0)
    expect(report.succeeded).toBe(0)
    expect(report.aborted).toBeUndefined()
  })

  it('all entries already embedded → nothing to do', async () => {
    const sidecar = makeSidecar([
      makeEntry('a', { metadata: { embedder_id: 'nomic-embed-text:v1' } }),
      makeEntry('b', { metadata: { embedder_id: 'nomic-embed-text:v1' } }),
    ])
    const opts = buildOpts(tmp, sidecar)
    const report = await runBackfill(opts)

    expect(report.total).toBe(0)
    expect(report.succeeded).toBe(0)
  })

  // -------------------------------------------------------------------------

  it('successful run writes metadata.embedder_id + embedded_at to sidecar', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('b'),
    ])
    const dbCalls: Array<{ id: string; vec: Float32Array }> = []
    const opts = buildOpts(tmp, sidecar, {
      openSparrowDB: () => makeMockDb({ recorded: dbCalls }),
    })

    const before = Date.now()
    const report = await runBackfill(opts)
    const after = Date.now()

    expect(report.total).toBe(2)
    expect(report.succeeded).toBe(2)
    expect(report.graphOrphan).toBe(0)
    expect(report.embedFailed).toBe(0)
    expect(dbCalls.map(c => c.id).sort()).toEqual(['a', 'b'])

    // Verify sidecar was persisted with metadata stamps.
    const persisted = JSON.parse(readFileSync(opts.sidecarPath, 'utf8')) as Record<string, SidecarEntry>
    for (const id of ['a', 'b']) {
      expect(persisted[id].metadata?.embedder_id).toBe('nomic-embed-text:v1')
      const at = String(persisted[id].metadata?.embedded_at)
      expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      // Sanity: timestamp falls within the test window.
      const t = Date.parse(at)
      expect(t).toBeGreaterThanOrEqual(before - 1)
      expect(t).toBeLessThanOrEqual(after + 1000)
    }

    // State file recorded both as completed.
    const state = JSON.parse(readFileSync(opts.statePath, 'utf8'))
    expect(state.completed.sort()).toEqual(['a', 'b'])
    expect(state.failed).toEqual([])
  })

  // -------------------------------------------------------------------------

  it('state-file resume: ids already in completed[] are skipped', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('b'),
      makeEntry('c'),
    ])
    const dbCalls: Array<{ id: string; vec: Float32Array }> = []
    const opts = buildOpts(tmp, sidecar, {
      openSparrowDB: () => makeMockDb({ recorded: dbCalls }),
    })

    // Pre-seed state file: pretend 'a' and 'b' were done in a previous run.
    writeFileSync(opts.statePath, JSON.stringify({
      completed: ['a', 'b'],
      failed: [],
      started_at: new Date().toISOString(),
      last_update_at: new Date().toISOString(),
    }), 'utf8')

    const report = await runBackfill(opts)

    expect(report.alreadyCompleted).toBe(2)
    expect(report.total).toBe(1)
    expect(report.succeeded).toBe(1)
    // Only 'c' should have been embedded.
    expect(dbCalls.map(c => c.id)).toEqual(['c'])
    // The mock embedder also confirms only 1 embed call.
    expect((opts.embeddingService as ReturnType<typeof makeMockEmbedder>).calls).toHaveLength(1)
  })

  // -------------------------------------------------------------------------

  it('honors concurrency limit (max 4 in flight)', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const sidecar = makeSidecar(ids.map(id => makeEntry(id)))
    const inFlight = { peak: 0, current: 0 }

    const embedder = makeMockEmbedder({ delayMs: 30, inFlight })
    const opts = buildOpts(tmp, sidecar, {
      embeddingService: embedder,
      concurrency: 4,
    })

    const report = await runBackfill(opts)

    expect(report.succeeded).toBe(10)
    // Concurrency cap held — peak in-flight should be exactly 4 (or less if
    // scheduler quirks coalesce, but absolutely not more).
    expect(inFlight.peak).toBeLessThanOrEqual(4)
    expect(inFlight.peak).toBeGreaterThan(1) // sanity: parallelism actually happened
  })

  // -------------------------------------------------------------------------

  it('RangeError "no node with id" → logs + skips, does NOT abort', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('orphan-1'),
      makeEntry('c'),
    ])

    const failWith = new Map<string, Error>()
    failWith.set('orphan-1', new RangeError('no node with id orphan-1 in label Knowledge'))
    const dbCalls: Array<{ id: string; vec: Float32Array }> = []

    const opts = buildOpts(tmp, sidecar, {
      openSparrowDB: () => makeMockDb({ failWith, recorded: dbCalls }),
    })

    const report = await runBackfill(opts)

    expect(report.aborted).toBeUndefined()
    expect(report.total).toBe(3)
    expect(report.succeeded).toBe(2)
    expect(report.graphOrphan).toBe(1)
    expect(report.embedFailed).toBe(0)
    expect(dbCalls.map(c => c.id).sort()).toEqual(['a', 'c'])

    const state = JSON.parse(readFileSync(opts.statePath, 'utf8'))
    expect(state.completed.sort()).toEqual(['a', 'c'])
    expect(state.failed).toHaveLength(1)
    expect(state.failed[0].id).toBe('orphan-1')
    expect(state.failed[0].reason).toMatch(/graph_orphan/)
  })

  // -------------------------------------------------------------------------

  it('TypeError (dim mismatch) → ABORTS the script', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('bad'),
      makeEntry('c'),
      makeEntry('d'),
    ])

    const failWith = new Map<string, Error>()
    failWith.set('bad', new TypeError('vector.length 512 does not match index dimensions 768'))

    const opts = buildOpts(tmp, sidecar, {
      // serial concurrency makes the test deterministic — when 'bad' aborts,
      // 'c' and 'd' will not be processed.
      concurrency: 1,
      openSparrowDB: () => makeMockDb({ failWith }),
    })

    // Force deterministic order by seeding sidecar object iteration. JS
    // iterates an object's string keys in insertion order, so we trust the
    // sidecar build. Verified by makeSidecar inserting 'a' first.
    const report = await runBackfill(opts)

    expect(report.aborted).toBeDefined()
    expect(report.aborted?.reason).toMatch(/fatal_typeerror/)
    expect(report.aborted?.reason).toMatch(/does not match/)
    // 'a' should have succeeded before 'bad' threw.
    expect(report.succeeded).toBe(1)
    // 'c' and 'd' should NOT have been processed (concurrency=1, abort after 'bad').
  })

  // -------------------------------------------------------------------------

  it('embed retry: succeeds after one transient failure, then commits', async () => {
    const sidecar = makeSidecar([makeEntry('a')])

    let callCount = 0
    const transientEmbedder: EmbeddingService = {
      embedderId: 'nomic-embed-text:v1',
      dimensions: 768,
      isAvailable: async () => true,
      embed: async () => {
        callCount++
        if (callCount === 1) throw new Error('ECONNREFUSED')
        return fakeVec(1)
      },
    }

    const opts = buildOpts(tmp, sidecar, {
      embeddingService: transientEmbedder,
      retryBackoffMs: 1,
    })

    const report = await runBackfill(opts)

    expect(callCount).toBe(2)
    expect(report.succeeded).toBe(1)
    expect(report.embedFailed).toBe(0)
  })

  it('embed retry exhausted → recorded as embedFailed, NOT aborted', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('always-fails'),
    ])

    const failOn = new Set(['content for always-fails'])
    const embedder = makeMockEmbedder({ failOn })
    const opts = buildOpts(tmp, sidecar, {
      embeddingService: embedder,
      retryBackoffMs: 1,
    })

    const report = await runBackfill(opts)

    expect(report.aborted).toBeUndefined()
    expect(report.succeeded).toBe(1)
    expect(report.embedFailed).toBe(1)

    const state = JSON.parse(readFileSync(opts.statePath, 'utf8'))
    expect(state.failed).toHaveLength(1)
    expect(state.failed[0].id).toBe('always-fails')
    expect(state.failed[0].reason).toMatch(/embed failed after retry/)
  })

  // -------------------------------------------------------------------------

  it('SparrowDB.open throws → returns aborted report with clear instruction', async () => {
    const sidecar = makeSidecar([makeEntry('a')])
    const lines: string[] = []

    const opts = buildOpts(tmp, sidecar, {
      log: m => lines.push(m),
      isDaemonRunning: () => false,  // gate passes
      openSparrowDB: () => {
        throw new Error('WriterBusy: another writer is already open')
      },
    })

    const report = await runBackfill(opts)

    expect(report.aborted).toBeDefined()
    expect(report.aborted?.reason).toMatch(/lock_contention/)
    expect(report.succeeded).toBe(0)
    // Must surface the actionable instruction.
    const text = lines.join('\n')
    expect(text).toMatch(/STOP THE LAUNCHD DAEMON FIRST/)
    expect(text).toMatch(/launchctl bootout/)
  })

  it('daemon probe → running: aborts BEFORE opening SparrowDB', async () => {
    const sidecar = makeSidecar([makeEntry('a')])
    const lines: string[] = []
    let openerCalled = false

    const opts = buildOpts(tmp, sidecar, {
      log: m => lines.push(m),
      isDaemonRunning: () => true,
      openSparrowDB: () => {
        openerCalled = true
        return makeMockDb()
      },
    })

    const report = await runBackfill(opts)

    expect(report.aborted).toBeDefined()
    expect(report.aborted?.reason).toMatch(/lock_contention/)
    // Critical: opener must NOT have run (we'd have taken a writer if it had).
    expect(openerCalled).toBe(false)
    expect(report.succeeded).toBe(0)
    const text = lines.join('\n')
    expect(text).toMatch(/Daemon \(com\.ryaker\.kms-mcp\) is currently running/)
    expect(text).toMatch(/launchctl bootout/)
  })

  it('daemon probe → running but dry-run → proceeds (read-only)', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('b'),
    ])

    const opts = buildOpts(tmp, sidecar, {
      dryRun: true,
      isDaemonRunning: () => true,  // daemon is running, but dry-run is read-only
      openSparrowDB: () => makeMockDb(),
    })

    const report = await runBackfill(opts)

    expect(report.aborted).toBeUndefined()
    expect(report.total).toBe(2)
    expect(report.succeeded).toBe(0)  // dry-run never persists
  })

  // -------------------------------------------------------------------------

  it('dry-run: counts but does NOT touch the graph or sidecar', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('b'),
    ])
    const dbCalls: Array<{ id: string; vec: Float32Array }> = []
    const opts = buildOpts(tmp, sidecar, {
      dryRun: true,
      openSparrowDB: () => makeMockDb({ recorded: dbCalls }),
    })

    const report = await runBackfill(opts)

    expect(report.total).toBe(2)
    expect(report.succeeded).toBe(0)
    expect(dbCalls).toHaveLength(0)

    // Sidecar on disk is unchanged — no embedder_id stamped.
    const persisted = JSON.parse(readFileSync(opts.sidecarPath, 'utf8')) as Record<string, SidecarEntry>
    expect(persisted.a.metadata?.embedder_id).toBeUndefined()
    expect(persisted.b.metadata?.embedder_id).toBeUndefined()

    // No state file written either (dry-run).
    expect(existsSync(opts.statePath)).toBe(false)
  })

  // -------------------------------------------------------------------------

  it('TypeError abort: sidecar is still persisted for entries that succeeded before abort', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('bad'),
      makeEntry('c'),
    ])

    const failWith = new Map<string, Error>()
    failWith.set('bad', new TypeError('vector.length 512 does not match index dimensions 768'))

    const opts = buildOpts(tmp, sidecar, {
      concurrency: 1, // deterministic: a → bad → (abort, c never runs)
      openSparrowDB: () => makeMockDb({ failWith }),
    })

    const report = await runBackfill(opts)

    expect(report.aborted).toBeDefined()
    expect(report.succeeded).toBe(1)

    // Even though the script aborted, 'a' succeeded and its embedder_id must
    // be persisted to the on-disk sidecar so the next resume run (which skips
    // 'a' via state.completed) doesn't end up with a sidecar missing the stamp.
    const persisted = JSON.parse(readFileSync(opts.sidecarPath, 'utf8')) as Record<string, SidecarEntry>
    expect(persisted['a'].metadata?.embedder_id).toBe('nomic-embed-text:v1')
    expect(persisted['a'].metadata?.embedded_at).toBeDefined()
  })

  it('resume: previously-completed entries get embedder_id stamped in final sidecar save', async () => {
    const sidecar = makeSidecar([
      makeEntry('a'),
      makeEntry('b'),
      makeEntry('c'),
    ])
    const dbCalls: Array<{ id: string; vec: Float32Array }> = []
    const opts = buildOpts(tmp, sidecar, {
      openSparrowDB: () => makeMockDb({ recorded: dbCalls }),
    })

    // Pre-seed state file: pretend 'a' and 'b' were done in a previous run.
    // Their sidecar entries still lack embedder_id (interrupted before saveSidecar ran).
    writeFileSync(opts.statePath, JSON.stringify({
      completed: ['a', 'b'],
      failed: [],
      started_at: new Date().toISOString(),
      last_update_at: new Date().toISOString(),
    }), 'utf8')

    const report = await runBackfill(opts)

    expect(report.alreadyCompleted).toBe(2)
    expect(report.succeeded).toBe(1) // only 'c' newly embedded

    // All three entries — including the two resumed ones — must have
    // embedder_id in the final sidecar write.
    const persisted = JSON.parse(readFileSync(opts.sidecarPath, 'utf8')) as Record<string, SidecarEntry>
    expect(persisted['a'].metadata?.embedder_id).toBe('nomic-embed-text:v1')
    expect(persisted['b'].metadata?.embedder_id).toBe('nomic-embed-text:v1')
    expect(persisted['c'].metadata?.embedder_id).toBe('nomic-embed-text:v1')
  })

  it('mixed batch: orphan + embed-fail + success all coexist in one run', async () => {
    const sidecar = makeSidecar([
      makeEntry('good-1'),
      makeEntry('orphan-1'),
      makeEntry('embed-fail-1'),
      makeEntry('good-2'),
    ])

    const failWith = new Map<string, Error>()
    failWith.set('orphan-1', new RangeError('no node with id orphan-1'))

    const failOn = new Set(['content for embed-fail-1'])
    const embedder = makeMockEmbedder({ failOn })

    const opts = buildOpts(tmp, sidecar, {
      embeddingService: embedder,
      retryBackoffMs: 1,
      openSparrowDB: () => makeMockDb({ failWith }),
    })

    const report = await runBackfill(opts)

    expect(report.aborted).toBeUndefined()
    expect(report.total).toBe(4)
    expect(report.succeeded).toBe(2)
    expect(report.graphOrphan).toBe(1)
    expect(report.embedFailed).toBe(1)
  })
})

describe('competing-writer detection mid-run', () => {
  // The 2026-08-01 incident: the startup gate passed, the run reported 1721
  // successes, and ~1150 of them were destroyed. The launchd job has
  // KeepAlive=true and runs `node --watch dist/index.js`, so the daemon
  // relaunched partway through, held an index snapshot from its own open(),
  // and saved that stale view over the backfill's work on its next write.
  // A gate that only fires at startup cannot see a writer that arrives later.

  it('aborts when the daemon reappears partway through the run', async () => {
    const tmp = makeTmpDir()
    const sidecar: Record<string, any> = {}
    for (let i = 0; i < 40; i++) sidecar[`id-${i}`] = { id: `id-${i}`, content: `entry ${i}`, metadata: {} }

    let probeCalls = 0
    const opts = buildOpts(tmp, sidecar, {
      concurrency: 1,
      writerCheckIntervalMs: 1,
      // Clean at the startup gate, then the daemon comes back.
      isDaemonRunning: () => ++probeCalls > 1,
    })
    const report = await runBackfill(opts)

    expect(report.aborted?.reason).toMatch(/^competing_writer:/)
    expect(report.aborted?.reason).toContain('com.ryaker.kms-mcp')
    // It must stop early rather than plough through the whole candidate set.
    expect(report.succeeded).toBeLessThan(40)
  })

  it('completes normally when no competing writer ever appears', async () => {
    const tmp = makeTmpDir()
    const sidecar: Record<string, any> = {}
    for (let i = 0; i < 5; i++) sidecar[`id-${i}`] = { id: `id-${i}`, content: `entry ${i}`, metadata: {} }

    const opts = buildOpts(tmp, sidecar, { writerCheckIntervalMs: 1, isDaemonRunning: () => false })
    const report = await runBackfill(opts)

    expect(report.aborted).toBeUndefined()
    expect(report.succeeded).toBe(5)
  })

  it('does not abort on a probe that throws — an unanswerable probe is not evidence', async () => {
    // Failing the run on a flaky launchctl would be worse than the risk it guards.
    const tmp = makeTmpDir()
    const sidecar: Record<string, any> = {}
    for (let i = 0; i < 5; i++) sidecar[`id-${i}`] = { id: `id-${i}`, content: `entry ${i}`, metadata: {} }

    let first = true
    const opts = buildOpts(tmp, sidecar, {
      writerCheckIntervalMs: 1,
      isDaemonRunning: () => { if (first) { first = false; return false } throw new Error('launchctl unavailable') },
    })
    const report = await runBackfill(opts)

    expect(report.aborted).toBeUndefined()
    expect(report.succeeded).toBe(5)
  })

  it('honours writerCheckIntervalMs=0 as "startup gate only"', async () => {
    const tmp = makeTmpDir()
    const sidecar: Record<string, any> = { 'id-0': { id: 'id-0', content: 'x', metadata: {} } }
    let probeCalls = 0
    const opts = buildOpts(tmp, sidecar, {
      writerCheckIntervalMs: 0,
      isDaemonRunning: () => { probeCalls++; return false },
    })
    const report = await runBackfill(opts)

    expect(report.aborted).toBeUndefined()
    expect(probeCalls).toBe(1)   // startup gate only, no re-checks scheduled
  })
})

// ---------------------------------------------------------------------------
// PR #93 CodeRabbit review fixes
// ---------------------------------------------------------------------------

describe('PR #93 review fixes', () => {
  // CRITICAL: checkForCompetingWriter() at the top of the task proves the
  // daemon was down when the task STARTED. embedWithRetry is a real network
  // round-trip (380-480ms measured against the Ollama host); a daemon that
  // reappears during that window is invisible until the NEXT entry's top-of-
  // task check. Re-check immediately before the write, not only at the top.
  it('re-checks contention after the embed and before the write — a writer detected during the embed window must not be written', async () => {
    const tmp = makeTmpDir()
    const sidecar = makeSidecar([makeEntry('a')])
    const dbCalls: Array<{ id: string; vec: Float32Array }> = []
    // Flipped by a real timer mid-embed, not counted probe calls:
    // checkForCompetingWriter()'s throttle means the exact number of real
    // (non-throttled) probe invocations before a given check is a race (an
    // ordinal-counting stub was flaky here — see the sibling test's comment).
    // A wall-clock flip well inside the 30ms embed window is deterministic:
    // the top-of-task check runs at ~t=0 (always sees `false`, timer not due
    // yet); the post-embed check this fix adds runs at ~t=30ms, long after
    // the 5ms flip (always sees `true`).
    let daemonReappeared = false
    setTimeout(() => { daemonReappeared = true }, 5)

    const opts = buildOpts(tmp, sidecar, {
      concurrency: 1,
      writerCheckIntervalMs: 1,
      embeddingService: makeMockEmbedder({ delayMs: 30 }),
      openSparrowDB: () => makeMockDb({ recorded: dbCalls }),
      isDaemonRunning: () => daemonReappeared,
    })

    const report = await runBackfill(opts)

    expect(report.aborted?.reason).toMatch(/^competing_writer:/)
    expect(dbCalls).toHaveLength(0) // must NOT have written — contention was known before the write
    expect(report.succeeded).toBe(0)
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
  })

  // CRITICAL: everything this run wrote is unsafe once a competing writer is
  // detected — SparrowDB rewrites the WHOLE file on every insert, so the other
  // process's next save overwrites this run's entire contribution with its
  // own stale open()-time snapshot, not just entries written after detection.
  // Persisting those ids as `completed` makes the next resume SKIP vectors
  // that no longer exist. On abort: revert state.completed/failed to the
  // pre-run snapshot, do not persist the sidecar, and do not checkpoint.
  it('does NOT persist unsafe writes as completed — a resume after a competing-writer abort must re-embed everything this run wrote', async () => {
    const tmp = makeTmpDir()
    const sidecar = makeSidecar([
      makeEntry('id-0'), makeEntry('id-1'), makeEntry('id-2'),
    ])
    const dbCalls: Array<{ id: string; vec: Float32Array }> = []
    let checkpointCalls = 0
    // Tied to a real EVENT (the first genuine write), not a probe-call
    // ordinal — checkForCompetingWriter()'s throttle window means the exact
    // number of real (non-throttled) probe invocations per task is a race
    // (sub-1ms scheduling decides whether a given check's probe call lands
    // before or after another task's), so counting calls is not
    // deterministic. Flipping a flag inside the write itself is: task 1's own
    // checks (top-of-task, and the post-embed one this PR adds) always run
    // BEFORE task 1's own write, so they always see `false` and task 1 always
    // completes; every check task 2 makes runs strictly after that write, so
    // it always sees `true` — regardless of which of its checks (if any got
    // throttled) is the one that actually re-probes.
    let daemonReappeared = false

    const db: SparrowDBLike = {
      addToVectorIndex: (_label, _prop, nodeId, vec) => {
        dbCalls.push({ id: nodeId, vec })
        daemonReappeared = true
      },
      checkpoint: () => { checkpointCalls++ },
    }

    const opts = buildOpts(tmp, sidecar, {
      concurrency: 1,
      writerCheckIntervalMs: 1,
      // Delay long enough that a post-embed check is never itself throttled
      // (it always fires >= 1ms after the previous real check).
      embeddingService: makeMockEmbedder({ delayMs: 20 }),
      openSparrowDB: () => db,
      isDaemonRunning: () => daemonReappeared,
    })

    const report = await runBackfill(opts)

    expect(report.aborted?.reason).toMatch(/^competing_writer:/)
    // The write to the vector index genuinely happened this run (unsafe, but real).
    expect(dbCalls.map(c => c.id)).toEqual(['id-0'])
    expect(report.succeeded).toBe(1)

    // Yet the persisted state file must NOT record 'id-0' as completed — a
    // resumed run has to re-embed and re-write it, not silently skip it.
    const state = JSON.parse(readFileSync(opts.statePath, 'utf8'))
    expect(state.completed).toEqual([])

    // The sidecar on disk must not carry this run's embedder_id stamp either.
    const persisted = JSON.parse(readFileSync(opts.sidecarPath, 'utf8')) as Record<string, SidecarEntry>
    expect(persisted['id-0'].metadata?.embedder_id).toBeUndefined()

    // No checkpoint on the way out of a competing-writer abort.
    expect(checkpointCalls).toBe(0)

    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
  })

  // MAJOR: the startup gate has done zero work when it runs, so refusing to
  // begin on an unanswerable probe costs nothing. This is the opposite of the
  // mid-run check, which stays lenient because aborting a long-running
  // backfill on a flaky launchctl is worse than the (small) risk it guards.
  it('fails CLOSED when the startup probe throws — refuses to start, never opens SparrowDB', async () => {
    const tmp = makeTmpDir()
    const sidecar = makeSidecar([makeEntry('a')])
    let openerCalled = false

    const opts = buildOpts(tmp, sidecar, {
      isDaemonRunning: () => { throw new Error('launchctl unavailable') },
      openSparrowDB: () => { openerCalled = true; return makeMockDb() },
    })

    const report = await runBackfill(opts)

    expect(report.aborted).toBeDefined()
    expect(report.aborted?.reason).toMatch(/lock_contention/)
    expect(openerCalled).toBe(false)
    expect(report.succeeded).toBe(0)
  })

  // MAJOR: operator instructions must use the launchd domain for the account
  // actually running the script, not a hardcoded gui/501 — consistent with
  // defaultIsDaemonRunning(), which already derives the domain from the
  // current process uid.
  it('operator instructions use the current UID, not a hardcoded gui/501', async () => {
    const tmp = makeTmpDir()
    const sidecar = makeSidecar([makeEntry('a')])
    const lines: string[] = []
    const getuidSpy = jest.spyOn(process, 'getuid' as any).mockReturnValue(777 as any)

    try {
      const opts = buildOpts(tmp, sidecar, {
        log: m => lines.push(m),
        isDaemonRunning: () => true, // trigger the "STOP THE LAUNCHD DAEMON" instructions
      })
      await runBackfill(opts)
    } finally {
      getuidSpy.mockRestore()
    }

    const text = lines.join('\n')
    expect(text).toContain('gui/777/')
    expect(text).not.toContain('gui/501')
  })
})
