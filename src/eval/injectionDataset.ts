/**
 * Prompt-injection eval dataset — four slices, three of which never touch git:
 *
 *  1. SYNTHETIC POSITIVES  (committed, `fixtures/injection-positives.json`) — 128 hand-authored
 *     KMS-style memories, each with an injection embedded in it, tagged by category.
 *  2. SYNTHETIC HARD NEGATIVES (committed, `fixtures/injection-hard-negatives.json`) — 122
 *     legitimate user-authored directives/procedures of the kind a user stores for their own
 *     agents ("never run Ollama on this Mac mini"), the exact shape the baseline over-fires on.
 *  3. DEEPSET POSITIVES (NOT committed, downloaded at runtime) — the `label==1` rows of
 *     deepset/prompt-injections (apache-2.0, verified 2026-09-24 on the dataset's HF page),
 *     fetched through the HF datasets-server rows API (JSON rows, no parquet parsing needed)
 *     and cached to `~/.kms/eval-cache/`.
 *  4. REAL NEGATIVES (NOT committed, NEVER printed) — a seeded sample of real SparrowDB
 *     content-index sidecar entries, read-only, from the two local stores
 *     (`~/.kms-eng/sparrowdb/content-index.json`, `~/.kms-sparrowdb-v2/content-index.json`).
 *     ASSUMPTION (stated per the task brief): this real corpus contains no actual injections,
 *     so every one of these rows is treated as ground-truth negative. Only ids and counts are
 *     ever surfaced by `eval-injection.ts`'s report — never content.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_SPARROWDB_DIRNAME } from '../storage/sparrowDbPath.js'

export type InjectionSampleSource = 'synthetic' | 'deepset' | 'real'
export type InjectionSampleLabel = 'positive' | 'negative'

export interface InjectionSample {
  id: string
  content: string
  label: InjectionSampleLabel
  source: InjectionSampleSource
  /** Attack category for a positive; `'directive_like'` for a real negative matched by the
   * directive regex; `null` otherwise. */
  category: string | null
  contentType?: string | null
  subject?: string | null
}

/**
 * Deliberately NOT resolved via `import.meta.url`/`dirname(fileURLToPath(...))`: this repo's
 * Jest config runs ts-jest's ESM preset but without `--experimental-vm-modules`, so it executes
 * tests as CommonJS — a module-scope `import.meta` reference fails to parse the moment a test
 * imports this file directly (see `SparrowDBStorage.resolveSparrowDBPath.test.ts`'s comment on
 * the identical, pre-existing constraint in `SparrowDBStorage.ts`). Resolved from the process's
 * working directory instead, since both the documented run command
 * (`npx tsx src/scripts/eval-injection.ts`) and `npx jest` are always invoked from the repo/
 * worktree root. Overridable via `fixturesDir` on each loader for tests that want an isolated dir.
 */
const FIXTURES_DIR = path.join(process.cwd(), 'src', 'eval', 'fixtures')

// ── synthetic fixtures (committed) ──────────────────────────────────────────

interface PositiveFixtureRow {
  id: string
  category: string
  contentType: string
  subject: string
  content: string
}

interface NegativeFixtureRow {
  id: string
  contentType: string
  subject: string
  content: string
}

export function loadSyntheticPositives(fixturesDir: string = FIXTURES_DIR): InjectionSample[] {
  const rows = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, 'injection-positives.json'), 'utf8')
  ) as PositiveFixtureRow[]
  return rows.map(r => ({
    id: r.id,
    content: r.content,
    label: 'positive',
    source: 'synthetic',
    category: r.category,
    contentType: r.contentType,
    subject: r.subject,
  }))
}

export function loadSyntheticHardNegatives(fixturesDir: string = FIXTURES_DIR): InjectionSample[] {
  const rows = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, 'injection-hard-negatives.json'), 'utf8')
  ) as NegativeFixtureRow[]
  return rows.map(r => ({
    id: r.id,
    content: r.content,
    label: 'negative',
    source: 'synthetic',
    category: null,
    contentType: r.contentType,
    subject: r.subject,
  }))
}

// ── deepset/prompt-injections (apache-2.0), fetched at runtime ─────────────
//
// License verified 2026-09-24 on https://huggingface.co/datasets/deepset/prompt-injections
// ("License: apache-2.0"). Rows are fetched through the HF datasets-server `/rows` endpoint,
// which returns parsed JSON rows directly — no parquet reader dependency needed for a 662-row
// dataset. Only `label == 1` (injection) rows are kept; this eval only needs an extra positive
// slice, and `deepset`'s own negatives are general chat, not KMS-shaped, so they would not be a
// fair "hard negative".

export const DEEPSET_DATASET = 'deepset/prompt-injections'
const DEEPSET_ROWS_ENDPOINT = 'https://datasets-server.huggingface.co/rows'
const DEEPSET_SPLITS = ['train', 'test'] as const
const DEEPSET_PAGE_SIZE = 100

export const DEEPSET_CACHE_PATH_ENV = 'INJECTION_EVAL_DEEPSET_CACHE_PATH'
export const DEFAULT_DEEPSET_CACHE_PATH = path.join(os.homedir(), '.kms', 'eval-cache', 'deepset-prompt-injections.json')

interface DeepsetRow {
  text: string
  label: number
}

interface DeepsetCacheFile {
  dataset: typeof DEEPSET_DATASET
  fetched_at: string
  rows: DeepsetRow[]
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

async function fetchAllDeepsetRows(fetchImpl: FetchLike, log: (msg: string) => void): Promise<DeepsetRow[]> {
  const all: DeepsetRow[] = []
  for (const split of DEEPSET_SPLITS) {
    let offset = 0
    for (;;) {
      const url = `${DEEPSET_ROWS_ENDPOINT}?dataset=${encodeURIComponent(DEEPSET_DATASET)}&config=default&split=${split}&offset=${offset}&length=${DEEPSET_PAGE_SIZE}`
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error(`deepset: rows fetch failed (${res.status}) for split=${split} offset=${offset}`)
      const data = (await res.json()) as { rows: Array<{ row: DeepsetRow }>; num_rows_total: number }
      for (const r of data.rows) all.push({ text: r.row.text, label: r.row.label })
      offset += DEEPSET_PAGE_SIZE
      if (offset >= data.num_rows_total || data.rows.length === 0) break
    }
    log(`deepset: fetched split=${split}`)
  }
  return all
}

export interface LoadDeepsetOptions {
  cachePath?: string
  fetchImpl?: FetchLike
  log?: (msg: string) => void
}

/**
 * Loads the deepset/prompt-injections `label==1` rows as extra positives. Downloads to
 * `cachePath` (default `~/.kms/eval-cache/deepset-prompt-injections.json`, NOT committed) on
 * first use; every later call is a local read with zero network traffic.
 */
export async function loadDeepsetPositives(options: LoadDeepsetOptions = {}): Promise<InjectionSample[]> {
  const cachePath = options.cachePath ?? process.env[DEEPSET_CACHE_PATH_ENV]?.trim() ?? DEFAULT_DEEPSET_CACHE_PATH
  const log = options.log ?? ((msg: string) => console.error(msg))

  let cached: DeepsetCacheFile | null = null
  try {
    cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as DeepsetCacheFile
  } catch {
    cached = null
  }

  let rows: DeepsetRow[]
  if (cached && Array.isArray(cached.rows) && cached.rows.length > 0) {
    rows = cached.rows
    log(`deepset: ${rows.length} row(s) from cache (${cachePath})`)
  } else {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    if (!fetchImpl) throw new Error('deepset: no fetch implementation available')
    rows = await fetchAllDeepsetRows(fetchImpl, log)
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 })
    const toWrite: DeepsetCacheFile = { dataset: DEEPSET_DATASET, fetched_at: new Date().toISOString(), rows }
    fs.writeFileSync(cachePath, JSON.stringify(toWrite), { mode: 0o600 })
    log(`deepset: fetched ${rows.length} row(s), cached to ${cachePath}`)
  }

  return rows
    .filter(r => r.label === 1)
    .map((r, i) => ({
      id: `deepset-${i.toString().padStart(4, '0')}`,
      content: r.text,
      label: 'positive' as const,
      source: 'deepset' as const,
      category: 'deepset_injection',
      contentType: null,
      subject: null,
    }))
}

// ── real negatives: seeded sample of SparrowDB content-index sidecars ──────
//
// Read-only. Never committed, never printed — `eval-injection.ts` surfaces ids and counts
// only. ASSUMPTION stated in the task brief and repeated in docs/eval/prompt-injection-eval.md:
// the real corpus contains no actual injections, so every sampled row is ground-truth negative.

// The second store is the canonical PERSONAL-KMS SparrowDB root. Built from
// `DEFAULT_SPARROWDB_DIRNAME` (the shared constant from sparrowDbPath.ts — not a re-typed
// quoted path, which the guard in SparrowDBStorage.resolveSparrowDBPath.test.ts scans for)
// rather than through `resolveSparrowDBPath()` itself: that function's precedence puts
// `$SPARROWDB_PATH` first, and under the `dev_eng` Doppler config that env var is deliberately
// set to the ENG store (confirmed via `doppler secrets get SPARROWDB_PATH --config dev_eng`),
// so calling the resolver here would silently collapse both "two distinct stores" into the same
// one whenever this script is run with `--config dev_eng` (the documented run command). This
// eval specifically wants the two named stores regardless of which config invoked it.
export const DEFAULT_REAL_CONTENT_INDEX_PATHS = [
  path.join(os.homedir(), '.kms-eng', 'sparrowdb', 'content-index.json'),
  path.join(os.homedir(), DEFAULT_SPARROWDB_DIRNAME, 'content-index.json'),
]

export const REAL_SAMPLE_SIZE_PER_STORE = 400
export const REAL_SAMPLE_SEED = 20260924

/** Same directive-like regex the task brief specifies. Case-insensitive, word-ish boundaries. */
export const DIRECTIVE_LIKE_REGEX = /\b(always|never|must|do not|don't|ignore|you are|assistant)\b/i

interface ContentIndexEntry {
  id: string
  content: string
  contentType?: string
  metadata?: { subject?: string } | null
  [k: string]: unknown
}

/** Deterministic LCG — same construction used elsewhere in this repo's eval harnesses
 * (`src/scripts/eval-recall-evidence.ts`'s `bootstrapDeltaCI`), reproduced locally so this
 * module has no dependency on that script. */
function makeRng(seed: number): () => number {
  let s = seed
  return () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32
}

/** Fisher-Yates using a seeded RNG — same sample every run for a given seed. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const arr = [...items]
  const rand = makeRng(seed)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export interface RealNegativeStoreCounts {
  path: string
  found: boolean
  totalEntries: number
  sampled: number
  directiveLike: number
}

export interface RealNegativeSampleResult {
  samples: InjectionSample[]
  perStore: RealNegativeStoreCounts[]
}

export interface SampleRealNegativesOptions {
  contentIndexPaths?: string[]
  sampleSizePerStore?: number
  seed?: number
  directiveRegex?: RegExp
}

/**
 * Seeded sample of `sampleSizePerStore` (default 400) entries per content-index sidecar, plus
 * every entry whose content matches `directiveRegex` (the "hard real negatives" slice) — deduped
 * against the random sample by id. A missing sidecar (e.g. this machine, CI, a test) is reported
 * as `found: false` with zero samples rather than thrown.
 */
export function sampleRealNegatives(options: SampleRealNegativesOptions = {}): RealNegativeSampleResult {
  const paths = options.contentIndexPaths ?? DEFAULT_REAL_CONTENT_INDEX_PATHS
  const sampleSize = options.sampleSizePerStore ?? REAL_SAMPLE_SIZE_PER_STORE
  const seed = options.seed ?? REAL_SAMPLE_SEED
  const directiveRegex = options.directiveRegex ?? DIRECTIVE_LIKE_REGEX

  const samples: InjectionSample[] = []
  const perStore: RealNegativeStoreCounts[] = []

  paths.forEach((storePath, storeIndex) => {
    if (!fs.existsSync(storePath)) {
      perStore.push({ path: storePath, found: false, totalEntries: 0, sampled: 0, directiveLike: 0 })
      return
    }
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Record<string, ContentIndexEntry>
    const entries = Object.values(raw).filter(e => typeof e?.content === 'string' && e.content.length > 0)

    const shuffled = seededShuffle(entries, seed + storeIndex)
    const sampled = shuffled.slice(0, sampleSize)
    const sampledIds = new Set(sampled.map(e => e.id))

    const directiveLike = entries.filter(e => directiveRegex.test(e.content) && !sampledIds.has(e.id))

    for (const e of sampled) {
      samples.push({
        id: e.id,
        content: e.content,
        label: 'negative',
        source: 'real',
        category: null,
        contentType: e.contentType ?? null,
        subject: e.metadata?.subject ?? null,
      })
    }
    for (const e of directiveLike) {
      samples.push({
        id: e.id,
        content: e.content,
        label: 'negative',
        source: 'real',
        category: 'directive_like',
        contentType: e.contentType ?? null,
        subject: e.metadata?.subject ?? null,
      })
    }

    perStore.push({
      path: storePath,
      found: true,
      totalEntries: entries.length,
      sampled: sampled.length,
      directiveLike: directiveLike.length,
    })
  })

  return { samples, perStore }
}
