/**
 * Offline eval: recall-evidence v2 vs v1 vs production order, on the labelled pool
 * (60 queries x 20 candidates, `{id, prod_rank, content, subject, jevA, jevB, grade}`).
 * This is the gate that decides whether v2 replaces v1 (build order step 2,
 * docs/architecture — or the current session's kms-jev-architecture-v2 note).
 *
 *   doppler run --project ry-local --config dev_eng -- npx tsx src/scripts/eval-recall-evidence.ts
 *
 * For every (query, candidate) pair this calls Jev with the v2 question set
 * (`RECALL_EVIDENCE_QUESTIONS_V2`) through `createJevDecisionEngineFromEnv()` and
 * `withEngineSlot` — the same production rate limiter (15 rps token bucket), so a run of
 * this script makes no more demand on the shared credential than a burst of real searches
 * would. Raw answers are cached to disk by state fingerprint (`RECALL_EVAL_CACHE_PATH`,
 * default `~/.kms/eval-cache/recall-evidence-v2.json`), so a re-run to change scoring
 * weights, thresholds, or metrics makes zero further calls.
 *
 * v1's score (`jevA`) and the grade labels are already in the pool — this script never
 * calls Jev for v1, only for v2.
 *
 * Submission is bounded (`mapBounded`, limit 40): firing all ~1,200 pairs into
 * `withEngineSlot` at once would queue far past the shared bucket's `JEV_ENGINE_QUEUE_MAX`
 * (100) and most would be refused with `EngineQueueFullError`. Keeping at most 40 pairs
 * "in acquire()" at a time lets the 15 rps bucket drain them without ever queuing that deep.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createJevDecisionEngineFromEnv } from '../decision/JevDecisionEngine.js'
import { withEngineSlot } from '../decision/engineSlot.js'
import {
  RECALL_EVIDENCE_QUESTIONS_V2,
  RECALL_EVIDENCE_V2_SCHEMA_VERSION,
  buildRecallStateV2,
  fingerprintRecallStateV2,
  type RecallCandidate,
} from '../decision/recallEvidence.js'
import { shadowScoreV2, type ShadowJudgmentV2 } from '../decision/shadowPolicy.js'
import { ndcgAtK, precisionAtK, reciprocalRank, type EvalCandidate, type Labels } from '../eval/rankers.js'

// ── pool ─────────────────────────────────────────────────────────────────────

export interface PoolCandidate {
  id: string
  prod_rank: number
  content: string
  subject?: string | null
  jevA: number
  jevB: number
  grade: number
}

export interface PoolQuery {
  query: string
  at?: string
  candidates: PoolCandidate[]
}

export const POOL_PATH_ENV = 'RECALL_EVAL_POOL_PATH'
export const DEFAULT_POOL_PATH =
  '/private/tmp/claude-501/-Users-ryaker-Dev-KMSmcp/1ce6df6c-67fe-49a9-ad58-3cdab1d12127/scratchpad/labels/pool.jsonl'

export function loadPool(filePath: string): PoolQuery[] {
  const text = fs.readFileSync(filePath, 'utf8')
  const out: PoolQuery[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const row = JSON.parse(line) as PoolQuery
    if (typeof row.query !== 'string' || !Array.isArray(row.candidates)) {
      throw new Error(`pool: malformed row (missing query/candidates): ${line.slice(0, 80)}`)
    }
    out.push(row)
  }
  return out
}

// ── cache ────────────────────────────────────────────────────────────────────

export interface CachedAnswer {
  answers_query: number
  evidence_value: number
  contradicts_premise: number
  contains_instruction: number
  describes_past_state: number
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd_estimate: number | null
}

export interface CacheFile {
  schema_version: string
  entries: Record<string, CachedAnswer>
}

export const CACHE_PATH_ENV = 'RECALL_EVAL_CACHE_PATH'
export const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.kms', 'eval-cache', 'recall-evidence-v2.json')

export function loadCache(filePath: string): CacheFile {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CacheFile
    if (raw.schema_version === RECALL_EVIDENCE_V2_SCHEMA_VERSION && raw.entries) return raw
    console.error(`cache: ${filePath} is for a different schema version (${String(raw.schema_version)}); starting fresh`)
  } catch {
    // No cache file yet, or unreadable — start fresh rather than fail the run over it.
  }
  return { schema_version: RECALL_EVIDENCE_V2_SCHEMA_VERSION, entries: {} }
}

function saveCache(filePath: string, cache: CacheFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, JSON.stringify(cache), { mode: 0o600 })
}

// ── bounded concurrency ──────────────────────────────────────────────────────

async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// ── evaluation (the only place that calls Jev) ──────────────────────────────

interface Pair {
  queryIndex: number
  query: string
  candidate: PoolCandidate
}

interface EvalResult {
  pair: Pair
  answer: CachedAnswer | null
  error: string | null
  fromCache: boolean
}

function toRecallCandidate(c: PoolCandidate): RecallCandidate {
  return { id: c.id, content: c.content, metadata: c.subject ? { subject: c.subject } : {} }
}

async function evaluatePool(pool: PoolQuery[], cache: CacheFile, cachePath: string): Promise<EvalResult[]> {
  const engine = createJevDecisionEngineFromEnv()
  if (!engine) {
    console.error('jev: no credential route (OneCLI gateway or TYPESAFE_API_KEY) — every uncached pair will fail')
  }

  const pairs: Pair[] = []
  pool.forEach((q, queryIndex) => {
    for (const candidate of q.candidates) pairs.push({ queryIndex, query: q.query, candidate })
  })

  let newCalls = 0
  let sinceFlush = 0

  const results = await mapBounded(pairs, 40, async (pair): Promise<EvalResult> => {
    const state = buildRecallStateV2(pair.query, toRecallCandidate(pair.candidate))
    const fingerprint = fingerprintRecallStateV2(state)
    const cached = cache.entries[fingerprint]
    if (cached) return { pair, answer: cached, error: null, fromCache: true }

    if (!engine) {
      return { pair, answer: null, error: 'no Jev credential route', fromCache: false }
    }

    try {
      const result = await withEngineSlot(() => engine.evaluate({ state, questions: RECALL_EVIDENCE_QUESTIONS_V2 }))
      const a = result.answers
      if (
        a.answers_query?.type !== 'noul' ||
        a.evidence_value?.type !== 'score' ||
        a.contradicts_premise?.type !== 'noul' ||
        a.contains_instruction?.type !== 'noul' ||
        a.describes_past_state?.type !== 'noul'
      ) {
        throw new Error('engine returned an answer of the wrong kind for a recall-evidence/v2 question')
      }
      const answer: CachedAnswer = {
        answers_query: a.answers_query.probability,
        evidence_value: a.evidence_value.score,
        contradicts_premise: a.contradicts_premise.probability,
        contains_instruction: a.contains_instruction.probability,
        describes_past_state: a.describes_past_state.probability,
        model: result.model,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cost_usd_estimate: result.costUsdEstimate,
      }
      cache.entries[fingerprint] = answer
      newCalls++
      sinceFlush++
      if (sinceFlush >= 50) {
        saveCache(cachePath, cache)
        sinceFlush = 0
      }
      return { pair, answer, error: null, fromCache: false }
    } catch (e) {
      return { pair, answer: null, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), fromCache: false }
    }
  })

  saveCache(cachePath, cache)
  console.error(`jev: ${newCalls} new call(s), ${results.filter(r => r.fromCache).length} served from cache`)
  return results
}

// ── ranking + scoring ────────────────────────────────────────────────────────

export interface RankedCandidate extends EvalCandidate {
  grade: number
  prodRank: number
}

export function baseRanked(q: PoolQuery): RankedCandidate[] {
  // Sorted by production rank first so every variant's `.sort()` (stable) breaks ties in
  // production order, the same rule `shadowOrder` uses.
  return [...q.candidates]
    .sort((a, b) => a.prod_rank - b.prod_rank)
    .map(c => ({ id: c.id, content: c.content, grade: c.grade, prodRank: c.prod_rank }))
}

function productionOrder(q: PoolQuery): RankedCandidate[] {
  return baseRanked(q)
}

export function v1Order(q: PoolQuery): RankedCandidate[] {
  const jevAById = new Map(q.candidates.map(c => [c.id, c.jevA]))
  return baseRanked(q).sort((a, b) => (jevAById.get(b.id) ?? 0) - (jevAById.get(a.id) ?? 0))
}

/**
 * v2 order from cached/fresh Jev answers. `correctedOrReplaced` is always `false`: the pool
 * carries no `metadata.flag` / `superseded_by`, so the correction multiplier
 * (`isCandidateCorrectedOrReplaced`) is not exercised by this eval — see the PR body's
 * "could not verify" note. A pair with no answer (a failed call) sorts after every judged
 * candidate but keeps its production tie-break against other unjudged pairs, mirroring how
 * `shadowOrder` treats an unjudged candidate as pinned rather than scored zero.
 */
function v2Order(q: PoolQuery, answersById: ReadonlyMap<string, CachedAnswer>): RankedCandidate[] {
  const withScore = baseRanked(q).map(c => {
    const a = answersById.get(c.id)
    if (!a) return { c, score: null as number | null }
    const judgment: ShadowJudgmentV2 = {
      answersQuery: a.answers_query,
      evidenceValue: a.evidence_value,
      containsInstruction: a.contains_instruction,
      describesPastState: a.describes_past_state,
      contradictsPremise: a.contradicts_premise,
      correctedOrReplaced: false,
    }
    return { c, score: shadowScoreV2(judgment).score }
  })
  return withScore.sort((x, y) => (y.score ?? -1) - (x.score ?? -1)).map(x => x.c)
}

// ── metrics ──────────────────────────────────────────────────────────────────

export type Mode = 'strict' | 'lenient'
type Variant = 'production' | 'v1' | 'v2'

export interface MetricSet {
  p1: number
  p3: number
  ndcg10: number
  mrr: number
}

export function labelsFor(candidates: RankedCandidate[], mode: Mode): Labels {
  const labels: Labels = {}
  for (const c of candidates) labels[c.id] = (mode === 'strict' ? c.grade === 2 : c.grade >= 1) ? 1 : 0
  return labels
}

export function metricsFor(ordered: RankedCandidate[], labels: Labels): MetricSet {
  return {
    p1: precisionAtK(ordered, labels, 1),
    p3: precisionAtK(ordered, labels, 3),
    ndcg10: ndcgAtK(ordered, labels, 10),
    mrr: reciprocalRank(ordered, labels),
  }
}

export function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export function meanMetricSet(sets: MetricSet[]): MetricSet {
  return {
    p1: avg(sets.map(s => s.p1)),
    p3: avg(sets.map(s => s.p3)),
    ndcg10: avg(sets.map(s => s.ndcg10)),
    mrr: avg(sets.map(s => s.mrr)),
  }
}

interface ComputeResult {
  table: Record<Variant, Record<Mode, MetricSet>>
  strictP1: Record<Variant, number[]>
}

function computeAll(pool: PoolQuery[], answersByQuery: ReadonlyMap<number, Map<string, CachedAnswer>>): ComputeResult {
  const perVariantMode: Record<Variant, Record<Mode, MetricSet[]>> = {
    production: { strict: [], lenient: [] },
    v1: { strict: [], lenient: [] },
    v2: { strict: [], lenient: [] },
  }
  const strictP1: Record<Variant, number[]> = { production: [], v1: [], v2: [] }

  pool.forEach((q, qi) => {
    const orders: Record<Variant, RankedCandidate[]> = {
      production: productionOrder(q),
      v1: v1Order(q),
      v2: v2Order(q, answersByQuery.get(qi) ?? new Map()),
    }

    for (const mode of ['strict', 'lenient'] as const) {
      const labels = labelsFor(baseRanked(q), mode)
      for (const variant of ['production', 'v1', 'v2'] as const) {
        perVariantMode[variant][mode].push(metricsFor(orders[variant], labels))
      }
    }

    const strictLabels = labelsFor(baseRanked(q), 'strict')
    for (const variant of ['production', 'v1', 'v2'] as const) {
      strictP1[variant].push(precisionAtK(orders[variant], strictLabels, 1))
    }
  })

  const table = {
    production: { strict: meanMetricSet(perVariantMode.production.strict), lenient: meanMetricSet(perVariantMode.production.lenient) },
    v1: { strict: meanMetricSet(perVariantMode.v1.strict), lenient: meanMetricSet(perVariantMode.v1.lenient) },
    v2: { strict: meanMetricSet(perVariantMode.v2.strict), lenient: meanMetricSet(perVariantMode.v2.lenient) },
  }
  return { table, strictP1 }
}

// ── paired comparison ────────────────────────────────────────────────────────

interface WinsLosses {
  wins: number
  losses: number
  ties: number
}

export function pairedWinsLosses(v2P1: number[], v1P1: number[]): WinsLosses {
  let wins = 0
  let losses = 0
  let ties = 0
  for (let i = 0; i < v2P1.length; i++) {
    if (v2P1[i] > v1P1[i]) wins++
    else if (v2P1[i] < v1P1[i]) losses++
    else ties++
  }
  return { wins, losses, ties }
}

interface BootstrapCI {
  mean: number
  lo: number
  hi: number
  iterations: number
}

/** Deterministic LCG (same construction as `decision-shadowPolicy.test.ts`) so a run reproduces. */
export function bootstrapDeltaCI(a: number[], b: number[], iterations = 10000, seed0 = 20260924): BootstrapCI {
  const n = a.length
  const diffs = a.map((x, i) => x - b[i])
  let seed = seed0
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32

  const means: number[] = []
  for (let it = 0; it < iterations; it++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)]
    means.push(sum / n)
  }
  means.sort((x, y) => x - y)
  const lo = means[Math.max(0, Math.min(iterations - 1, Math.floor(0.025 * iterations)))]
  const hi = means[Math.max(0, Math.min(iterations - 1, Math.floor(0.975 * iterations)))]
  return { mean: avg(diffs), lo, hi, iterations }
}

// ── rule counts ──────────────────────────────────────────────────────────────

interface FlagCounts {
  instructionCount: number
  instructionSample: string[]
  contradictionCount: number
  contradictionSample: string[]
  judged: number
}

export function flagCounts(results: EvalResult[]): FlagCounts {
  const instruction: string[] = []
  const contradiction: string[] = []
  let judged = 0
  for (const r of results) {
    if (!r.answer) continue
    judged++
    if (r.answer.contains_instruction > 0.7) instruction.push(r.pair.candidate.id)
    if (r.answer.contradicts_premise > 0.7) contradiction.push(r.pair.candidate.id)
  }
  return {
    instructionCount: instruction.length,
    instructionSample: instruction.slice(0, 3),
    contradictionCount: contradiction.length,
    contradictionSample: contradiction.slice(0, 3),
    judged,
  }
}

// ── report ───────────────────────────────────────────────────────────────────

function fmt(x: number): string {
  return x.toFixed(4)
}

const METRIC_ROWS = [
  ['P@1', 'p1'],
  ['P@3', 'p3'],
  ['nDCG@10', 'ndcg10'],
  ['MRR', 'mrr'],
] as const

function renderTable(table: ComputeResult['table']): string {
  const lines: string[] = []
  for (const mode of ['strict', 'lenient'] as const) {
    lines.push(`-- ${mode} (grade ${mode === 'strict' ? '== 2' : '>= 1'} counted relevant) --`)
    lines.push(`  ${'metric'.padEnd(9)}  ${'production'.padEnd(10)}  ${'v1'.padEnd(10)}  v2`)
    for (const [label, key] of METRIC_ROWS) {
      lines.push(
        `  ${label.padEnd(9)}  ${fmt(table.production[mode][key]).padEnd(10)}  ${fmt(table.v1[mode][key]).padEnd(10)}  ${fmt(table.v2[mode][key])}`
      )
    }
  }
  return lines.join('\n')
}

function signed(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(4)}`
}

export async function main(): Promise<void> {
  const poolPath = process.env[POOL_PATH_ENV]?.trim() || DEFAULT_POOL_PATH
  const cachePath = process.env[CACHE_PATH_ENV]?.trim() || DEFAULT_CACHE_PATH
  console.error(`pool: ${poolPath}`)
  console.error(`cache: ${cachePath}`)

  const pool = loadPool(poolPath)
  const totalPairs = pool.reduce((n, q) => n + q.candidates.length, 0)
  console.error(`pool: ${pool.length} queries, ${totalPairs} (query, candidate) pairs`)

  const cache = loadCache(cachePath)
  const results = await evaluatePool(pool, cache, cachePath)

  const failed = results.filter(r => r.error !== null)
  if (failed.length) {
    console.error(`jev: ${failed.length}/${results.length} pairs failed and are excluded from v2 scoring`)
    for (const f of failed.slice(0, 5)) console.error(`  candidate ${f.pair.candidate.id}: ${f.error}`)
  }

  const answersByQuery = new Map<number, Map<string, CachedAnswer>>()
  for (const r of results) {
    if (!r.answer) continue
    if (!answersByQuery.has(r.pair.queryIndex)) answersByQuery.set(r.pair.queryIndex, new Map())
    answersByQuery.get(r.pair.queryIndex)!.set(r.pair.candidate.id, r.answer)
  }

  const { table, strictP1 } = computeAll(pool, answersByQuery)
  const wl = pairedWinsLosses(strictP1.v2, strictP1.v1)
  const ci = bootstrapDeltaCI(strictP1.v2, strictP1.v1)
  const flags = flagCounts(results)

  const newlyCalled = results.filter(r => !r.fromCache && r.answer !== null)
  const totalCost = newlyCalled.reduce((s, r) => s + (r.answer?.cost_usd_estimate ?? 0), 0)

  console.log('Recall evidence v2 offline eval — production / v1 / v2, strict vs lenient grading')
  console.log('')
  console.log(`pool: ${pool.length} queries x ${pool[0]?.candidates.length ?? 0} candidates = ${results.length} pairs`)
  console.log(
    `jev: ${newlyCalled.length} new call(s), ${results.filter(r => r.fromCache).length} served from cache, ${failed.length} failed`
  )
  console.log(`jev cost (new calls only, at configured pricing): $${totalCost.toFixed(4)}`)
  console.log('')
  console.log(renderTable(table))
  console.log('')
  console.log(`paired top-1 (strict grading), v2 vs v1: wins ${wl.wins}, losses ${wl.losses}, ties ${wl.ties}  (n=${pool.length} queries)`)
  console.log(
    `bootstrap 95% CI, mean(P@1 v2 - P@1 v1) strict: ${signed(ci.mean)}  [${signed(ci.lo)}, ${signed(ci.hi)}]  (${ci.iterations} resamples)`
  )
  console.log('')
  console.log(
    `contains_instruction > 0.7: ${flags.instructionCount}/${flags.judged} judged candidates  ids: ${JSON.stringify(flags.instructionSample)}`
  )
  console.log(
    `contradicts_premise > 0.7: ${flags.contradictionCount}/${flags.judged} judged candidates  ids: ${JSON.stringify(flags.contradictionSample)}`
  )
}

// Only run when executed directly (`tsx src/scripts/eval-recall-evidence.ts`), not when
// imported by a test for its pure helpers (`pairedWinsLosses`, `bootstrapDeltaCI`, `loadPool`, `flagCounts`).
if (process.argv[1] && process.argv[1].endsWith('eval-recall-evidence.ts')) {
  main().catch(e => {
    console.error('fatal:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
