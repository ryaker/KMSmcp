/**
 * Reusable relevance-labelling pipeline for recall — production order vs the v2 Jev
 * policy (`recall-shadow-policy/v2`), over REAL queries pulled from the on-disk
 * recall-shadow decision logs (every one of those rows is a logged production search).
 *
 * Generalises the one-off 60-query prototype
 * (`/private/tmp/claude-501/-Users-ryaker-Dev-KMSmcp/1ce6df6c-67fe-49a9-ad58-3cdab1d12127/scratchpad/label-pass.mts`):
 * same grading prompt (verbatim, so old and new labels are comparable), same Gemma model
 * on rym1, same strict/lenient label split — but every distinct query from BOTH decision
 * logs (eng + personal), not a hand-picked sample, and resumable/cacheable so a partial
 * run never re-pays for a search, a grade, or a Jev judgment it already has.
 *
 * Usage:
 *   doppler run --project ry-local --config dev_eng -- \
 *     npx tsx src/scripts/label-recall-pool.ts [--limit N] [--source eng|personal|all] [--report-only] [--concurrency N]
 *
 * For each query (its own server, `options.jevRerank: false` — the eval-only bypass in
 * `UnifiedSearchTool.search()`):
 *   1. Search top 20, establish PRODUCTION order (see "bypass fallback" below).
 *   2. Grade every candidate 0/1/2 with Gemma (gemma4:12b-mlx on rym1 ONLY — never
 *      localhost, this Mac never runs inference), cached on disk by
 *      sha256(query + candidate id + content).
 *   3. Score every candidate with the v2 Jev policy (`RECALL_EVIDENCE_QUESTIONS_V2` /
 *      `buildRecallStateV2` / `shadowScoreV2`, through `createJevDecisionEngineFromEnv()`
 *      and `withEngineSlot` — the same production rate limiter every other Jev caller
 *      shares), cached the same way.
 *
 * Bypass fallback: the `jevRerank:false` bypass may not be deployed on the server this
 * script is pointed at yet. Detected the same way any caller reads `_rerank`:
 * `_rerank.applied === true` means the server ignored the bypass and served a Jev-reordered
 * response, not production's. When that happens this script reconstructs production order
 * by sorting the returned pool by `_score` descending (the production composite
 * `rankResults` computes before any Jev reorder touches it) and logs a warning. Every pool
 * row records which path produced its order (`production_path`).
 *
 * Output (append-only, resumable by (source, query)):
 *   ~/.kms/eval/label-pool.jsonl      — one row per (source, query): candidates, grades, jev scores
 *   ~/.kms/eval/labels-strict.jsonl   — {"query","labels"} recomputed from the pool every run
 *   ~/.kms/eval/labels-lenient.jsonl  — same, relevant = grade >= 1
 *   ~/.kms/eval/cache/grades.jsonl    — {"key","grade"} — Gemma grade cache
 *   ~/.kms/eval/cache/jev-v2.jsonl    — {"key", ...JevCacheEntry} — Jev v2 answer cache
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createJevDecisionEngineFromEnv } from '../decision/JevDecisionEngine.js'
import { withEngineSlot } from '../decision/engineSlot.js'
import {
  RECALL_EVIDENCE_QUESTIONS_V2,
  buildRecallStateV2,
  isCandidateCorrectedOrReplaced,
  type RecallCandidate,
} from '../decision/recallEvidence.js'
import { shadowScoreV2, type ShadowJudgmentV2 } from '../decision/shadowPolicy.js'
import type { DecisionEngine } from '../decision/types.js'
import { ndcgAtK, precisionAtK, reciprocalRank, type EvalCandidate, type Labels } from '../eval/rankers.js'
import { bootstrapDeltaCI, pairedWinsLosses } from './eval-recall-evidence.js'
import { MinimalMcpClient } from './import-slack-huddles.js'

// ── config ───────────────────────────────────────────────────────────────────

export const ENG_LOG_PATH = path.join(os.homedir(), '.kms', 'decision-log', 'eng-recall-shadow.jsonl')
export const PERSONAL_LOG_PATH = path.join(os.homedir(), '.kms', 'decision-log', 'recall-shadow.jsonl')

export const ENG_MCP_URL = 'http://localhost:8181/mcp'
export const PERSONAL_MCP_URL = 'http://localhost:8180/mcp'

/**
 * rym1 ONLY. Hardcoded, no env override — the whole point is that this Mac (a 16 GB CI
 * host) never runs inference, and an override knob here would be exactly the mistake to
 * guard against. See CLAUDE.md "Never run Ollama inference on this Mac mini".
 */
export const RYM1_HOST = '100.127.128.76'
export const GEMMA_URL = `http://${RYM1_HOST}:11434/api/generate`
export const GEMMA_MODEL = 'gemma4:12b-mlx'
if (!GEMMA_URL.includes(RYM1_HOST)) {
  // Defensive — this can only fire if the constant above is edited incorrectly.
  throw new Error(`GEMMA_URL must point at rym1 (${RYM1_HOST}) — refusing to run inference elsewhere`)
}

export const OUT_DIR = path.join(os.homedir(), '.kms', 'eval')
export const POOL_PATH = path.join(OUT_DIR, 'label-pool.jsonl')
export const LABELS_STRICT_PATH = path.join(OUT_DIR, 'labels-strict.jsonl')
export const LABELS_LENIENT_PATH = path.join(OUT_DIR, 'labels-lenient.jsonl')
export const GRADE_CACHE_PATH = path.join(OUT_DIR, 'cache', 'grades.jsonl')
export const JEV_CACHE_PATH = path.join(OUT_DIR, 'cache', 'jev-v2.jsonl')

/** The one-off prototype's output — seeds the grade cache so the same (query, candidate,
 *  content) never gets asked of Gemma twice across the two runs. */
export const PROTOTYPE_POOL_PATH =
  '/private/tmp/claude-501/-Users-ryaker-Dev-KMSmcp/1ce6df6c-67fe-49a9-ad58-3cdab1d12127/scratchpad/labels/pool.jsonl'

export const CONTENT_CAP = 1500
export const TOPK = 20

// ── query collection (pure) ─────────────────────────────────────────────────

export type Source = 'eng' | 'personal'
export type QueryKind = 'human' | 'agent-payload'

export interface QueryItem {
  query: string
  source: Source
  kind: QueryKind
}

/**
 * Same regex heuristic the 60-query prototype used to KEEP only human-looking queries
 * (`label-pass.mts`) — reused here to TAG rather than drop, per the brief: agent/hook
 * payloads are real production traffic the prompt hook sends, and are kept, not filtered.
 * The tag exists only so the report can slice by it.
 */
const AGENT_PAYLOAD_PREFIX = /^(<|You are|Read and fully|Messenger only|\[SYSTEM|Caveat)/

export function classifyQueryKind(query: string): QueryKind {
  const wordCount = query.split(/\s+/).filter(Boolean).length
  if (
    AGENT_PAYLOAD_PREFIX.test(query) ||
    query.length < 25 ||
    query.length > 600 ||
    wordCount < 5
  ) {
    return 'agent-payload'
  }
  return 'human'
}

/**
 * Distinct queries from one recall-shadow decision log, first-seen order. Lenient parsing
 * (like `parseShadowLog`): the log is appended to by a running daemon, so one bad byte
 * must not fail the whole read.
 */
export function collectQueriesFromLog(text: string, source: Source): QueryItem[] {
  const seen = new Set<string>()
  const out: QueryItem[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const q = (row as { query?: unknown } | null)?.query
    if (typeof q !== 'string') continue
    const query = q.trim()
    if (!query || seen.has(query)) continue
    seen.add(query)
    out.push({ query, source, kind: classifyQueryKind(query) })
  }
  return out
}

/**
 * Distinct query items across BOTH logs. Deduplicated per (source, query), not just per
 * query text: the same wording against eng vs personal searches two different corpora and
 * is two separate work items.
 */
export function collectAllQueries(engText: string, personalText: string): QueryItem[] {
  return [...collectQueriesFromLog(engText, 'eng'), ...collectQueriesFromLog(personalText, 'personal')]
}

// ── cache key (pure) ────────────────────────────────────────────────────────

/**
 * sha256(query, candidate id, content), hex — NUL-separated so "ab"+"c" and "a"+"bc"
 * cannot collide. Shared by the Gemma grade cache and the Jev v2 answer cache, so a
 * re-run or a resume never re-asks either. `content` must be the CAPPED (1500-char)
 * string — the same one stored in the pool row and sent to Gemma — so a key computed
 * here always matches the key a later run (or the prototype-pool seed) computes for the
 * same (query, id, content).
 */
export function labelCacheKey(query: string, candidateId: string, content: string): string {
  return crypto.createHash('sha256').update(query).update('\u0000').update(candidateId).update('\u0000').update(content).digest('hex')
}

export function capContent(content: string): string {
  return content.length > CONTENT_CAP ? content.slice(0, CONTENT_CAP) : content
}

// ── query tag for logging (never print raw query text — it may carry a credential) ────

export function queryTag(query: string): string {
  const hash = crypto.createHash('sha256').update(query).digest('hex').slice(0, 12)
  return `sha256:${hash} len=${query.length}`
}

// ── pool file (resume) ──────────────────────────────────────────────────────

export interface PoolCandidateRow {
  id: string
  prod_rank: number
  content: string
  subject: string | null
  sourceSystem: string | null
  grade: number | null
  jev: JevCacheEntry | null
}

export interface PoolRow {
  query: string
  source: Source
  kind: QueryKind
  at: string
  /** Which path produced `candidates`' order — see the module doc comment. */
  production_path: 'bypass' | 'score-reconstructed'
  candidates: PoolCandidateRow[]
}

export function loadPoolRows(filePath: string): PoolRow[] {
  if (!fs.existsSync(filePath)) return []
  const text = fs.readFileSync(filePath, 'utf8')
  const out: PoolRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      out.push(JSON.parse(line) as PoolRow)
    } catch {
      // A partial tail line from a run in flight, or corruption — skip, don't fail the read.
    }
  }
  return out
}

/** `${source}\0${query}` — the same query text against two different servers is two
 *  separate work items (see `collectAllQueries`), so resume keys on the pair. */
export function poolRowKey(source: Source, query: string): string {
  return `${source}\u0000${query}`
}

export function alreadyDoneKeys(rows: PoolRow[]): Set<string> {
  return new Set(rows.map(r => poolRowKey(r.source, r.query)))
}

function appendJsonLine(filePath: string, row: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, { mode: 0o600 })
}

// ── grade cache ──────────────────────────────────────────────────────────────

export type GradeCache = Map<string, number>

export function loadGradeCache(filePath: string): GradeCache {
  const map: GradeCache = new Map()
  if (!fs.existsSync(filePath)) return map
  for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const row = JSON.parse(line) as { key?: unknown; grade?: unknown }
      if (typeof row.key === 'string' && typeof row.grade === 'number') map.set(row.key, row.grade)
    } catch {
      // skip malformed line, keep the rest
    }
  }
  return map
}

/**
 * Seed the grade cache from the 60-query prototype's pool.jsonl, "when ids and content
 * match" — i.e. only entries whose cache key (sha256 of query + id + the SAME capped
 * content) is not already present. The prototype's `content` field is already capped to
 * 1500 chars, matching `capContent` here, so a candidate the prototype graded and this
 * script later re-encounters hashes identically without any special-casing.
 */
export function seedGradeCacheFromPrototype(cache: GradeCache, prototypePoolText: string): number {
  let seeded = 0
  for (const raw of prototypePoolText.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const r = row as { query?: unknown; candidates?: unknown }
    if (typeof r.query !== 'string' || !Array.isArray(r.candidates)) continue
    for (const c of r.candidates as unknown[]) {
      const cand = c as { id?: unknown; content?: unknown; grade?: unknown }
      if (typeof cand.id !== 'string' || typeof cand.content !== 'string' || typeof cand.grade !== 'number') continue
      const key = labelCacheKey(r.query, cand.id, cand.content)
      if (!cache.has(key)) {
        cache.set(key, cand.grade)
        seeded++
      }
    }
  }
  return seeded
}

// ── Gemma grading ────────────────────────────────────────────────────────────

/** Reused VERBATIM from the 60-query prototype (`label-pass.mts`) so old and new labels
 *  stay comparable. Do not reword without re-labelling everything that came before. */
export function gemmaGradePrompt(query: string, content: string): string {
  return `You are grading search results from a personal engineering knowledge base.

Query: ${query}

Stored entry:
${content.slice(0, 2500)}

How useful is this entry for answering or acting on the query?
2 = it directly answers the query or is essential context for acting on it
1 = related and somewhat useful, but does not answer it
0 = not useful (different topic, or only shares words)

Answer with JSON: {"grade": 0, 1, or 2}.`
}

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ json(): Promise<unknown> }>

/** Grades one candidate 0/1/2, or null after two failed attempts (network error, timeout,
 *  or a response that doesn't parse to {0,1,2}). Never throws. */
export async function gemmaGrade(query: string, content: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<number | null> {
  const prompt = gemmaGradePrompt(query, content)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(GEMMA_URL, {
        method: 'POST',
        body: JSON.stringify({
          model: GEMMA_MODEL,
          prompt,
          stream: false,
          think: false,
          format: { type: 'object', properties: { grade: { type: 'integer', enum: [0, 1, 2] } }, required: ['grade'] },
          options: { temperature: 0, num_predict: 20 },
        }),
        signal: AbortSignal.timeout(120_000),
      })
      const data = (await res.json()) as { response?: string }
      const parsed = JSON.parse(String(data.response)) as { grade?: unknown }
      if (parsed.grade === 0 || parsed.grade === 1 || parsed.grade === 2) return parsed.grade
    } catch {
      // retry once
    }
  }
  return null
}

// ── Jev v2 cache ─────────────────────────────────────────────────────────────

export interface JevCacheEntry {
  score: number
  containsInstructionFlag: boolean
  contradictsPremiseFlag: boolean
  answersQuery: number
  evidenceValue: number
  containsInstruction: number
  describesPastState: number
  contradictsPremise: number
}

export function loadJevCache(filePath: string): Map<string, JevCacheEntry> {
  const map = new Map<string, JevCacheEntry>()
  if (!fs.existsSync(filePath)) return map
  for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const row = JSON.parse(line) as { key?: unknown } & Partial<JevCacheEntry>
      if (typeof row.key === 'string' && typeof row.score === 'number') {
        const { key: _key, ...entry } = row
        map.set(row.key, entry as JevCacheEntry)
      }
    } catch {
      // skip malformed line, keep the rest
    }
  }
  return map
}

/** One (query, candidate) judged with the v2 question set and scored with `shadowScoreV2`
 *  — the exact machinery `evaluateOneCandidate` (`shadowRerank.ts`) uses for a served
 *  search, called directly here so this script can cache per-candidate rather than only
 *  per-batch. `candidate` should be the ORIGINAL retrieval result with `content` replaced
 *  by the capped string, so `flag`/`superseded_by`/`metadata` survive into
 *  `isCandidateCorrectedOrReplaced`. */
export async function judgeCandidateV2(engine: DecisionEngine, query: string, candidate: RecallCandidate): Promise<JevCacheEntry> {
  const state = buildRecallStateV2(query, candidate)
  const correctedOrReplaced = isCandidateCorrectedOrReplaced(candidate)
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
  const judgment: ShadowJudgmentV2 = {
    answersQuery: a.answers_query.probability,
    evidenceValue: a.evidence_value.score,
    containsInstruction: a.contains_instruction.probability,
    describesPastState: a.describes_past_state.probability,
    contradictsPremise: a.contradicts_premise.probability,
    correctedOrReplaced,
  }
  const scored = shadowScoreV2(judgment)
  return {
    score: scored.score,
    containsInstructionFlag: scored.containsInstructionFlag,
    contradictsPremiseFlag: scored.contradictsPremiseFlag,
    answersQuery: judgment.answersQuery,
    evidenceValue: judgment.evidenceValue,
    containsInstruction: judgment.containsInstruction,
    describesPastState: judgment.describesPastState,
    contradictsPremise: judgment.contradictsPremise,
  }
}

// ── search + bypass detection ───────────────────────────────────────────────

export interface RawCandidate {
  id: string
  content: string
  metadata?: { subject?: string | null; [k: string]: unknown } | null
  sourceSystem?: string
  _sourceSystems?: string[]
  _score?: number
  [k: string]: unknown
}

export interface McpToolClient {
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>
  initialize?(): Promise<void>
}

/** True when the server ignored `jevRerank:false` and served a Jev-reordered response —
 *  the bypass is not deployed there yet. Detected exactly the way a normal caller reads
 *  `_rerank`: `applied === true` means `results` is NOT production's order. */
export function bypassWasIgnored(response: { _rerank?: { applied?: boolean } } | null | undefined): boolean {
  return response?._rerank?.applied === true
}

/** Fallback when the bypass was ignored: sort the returned pool by `_score` descending —
 *  the production composite `rankResults` computes before any Jev reorder touches it.
 *  An approximation over only the returned (already `maxResults`-sliced) window, not a
 *  full re-search — kept as the fallback path, with a warning, per the brief. */
export function reconstructProductionOrder<T extends { _score?: unknown }>(results: T[]): T[] {
  return [...results].sort((a, b) => (Number(b._score) || 0) - (Number(a._score) || 0))
}

export interface SearchOutcome {
  candidates: RawCandidate[]
  path: 'bypass' | 'score-reconstructed'
}

async function searchOneQuery(client: McpToolClient, query: string, maxResults = TOPK): Promise<SearchOutcome> {
  const res = await client.callTool<{ results?: RawCandidate[]; _rerank?: { applied?: boolean } }>('unified_search', {
    query,
    options: { maxResults, includeRelationships: false, jevRerank: false },
  })
  const results: RawCandidate[] = Array.isArray(res?.results) ? res.results : []
  if (bypassWasIgnored(res)) {
    console.error(`warn: server ignored jevRerank:false bypass for ${queryTag(query)} — reconstructing production order from _score`)
    return { candidates: reconstructProductionOrder(results), path: 'score-reconstructed' }
  }
  return { candidates: results, path: 'bypass' }
}

/** Retries once, re-initialising the MCP session, on a session-expiry/404 — the same
 *  heuristic the prototype used against a long-running daemon. */
export async function searchOneQueryWithRetry(client: McpToolClient, query: string, maxResults = TOPK): Promise<SearchOutcome> {
  try {
    return await searchOneQuery(client, query, maxResults)
  } catch (e) {
    if (!/Session expired|404/.test(String(e)) || typeof client.initialize !== 'function') throw e
    await client.initialize()
    return await searchOneQuery(client, query, maxResults)
  }
}

// ── labels (pure) ────────────────────────────────────────────────────────────

export type LabelMode = 'strict' | 'lenient'

export function isRelevant(grade: number, mode: LabelMode): boolean {
  return mode === 'strict' ? grade === 2 : grade >= 1
}

export function buildLabelsForQuery(row: PoolRow, mode: LabelMode): Labels {
  const labels: Labels = {}
  for (const c of row.candidates) if (c.grade !== null) labels[c.id] = isRelevant(c.grade, mode) ? 1 : 0
  return labels
}

/** `{"query","labels"}` JSONL lines, the shape `src/eval/shadowRunMetrics.ts`'s
 *  `parseLabels` accepts. */
export function labelLinesForMode(rows: PoolRow[], mode: LabelMode): string[] {
  return rows.map(r => JSON.stringify({ query: r.query, labels: buildLabelsForQuery(r, mode) }))
}

// ── orderings (pure) ─────────────────────────────────────────────────────────

export function productionOrder(row: PoolRow): EvalCandidate[] {
  return [...row.candidates].sort((a, b) => a.prod_rank - b.prod_rank).map(c => ({ id: c.id, content: '' }))
}

/** Sorted by `jev.score` descending; ties (including "no jev answer", scored -1 so it
 *  sorts last) break in production order — `.sort()` is stable and the input is already
 *  production-ordered, mirroring `shadowOrder`'s tie-break rule. */
export function jevV2Order(row: PoolRow): EvalCandidate[] {
  return [...row.candidates]
    .sort((a, b) => a.prod_rank - b.prod_rank)
    .map(c => ({ id: c.id, content: '', _jevScore: c.jev?.score ?? -1 }))
    .sort((a, b) => (b._jevScore as number) - (a._jevScore as number))
}

// ── metrics (pure) ───────────────────────────────────────────────────────────

export interface MetricSet {
  p1: number
  p3: number
  ndcg10: number
  mrr: number
}

export function metricsFor(ordered: EvalCandidate[], labels: Labels): MetricSet {
  return {
    p1: precisionAtK(ordered, labels, 1),
    p3: precisionAtK(ordered, labels, 3),
    ndcg10: ndcgAtK(ordered, labels, 10),
    mrr: reciprocalRank(ordered, labels),
  }
}

function avg(xs: number[]): number {
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

export interface QueryMetricRow {
  source: Source
  kind: QueryKind
  mode: LabelMode
  production: MetricSet
  jev: MetricSet
  /** P@1 (0 or 1) under each ordering — the paired top-1 comparison unit. */
  prodTop1: number
  jevTop1: number
}

/**
 * Per-(query, mode) metric row. A query with NO relevant candidate under a mode is
 * excluded for that mode — "no relevant candidate: ordering can't be judged", same
 * exclusion the prototype's report applied.
 */
export function computeQueryMetrics(row: PoolRow): QueryMetricRow[] {
  const out: QueryMetricRow[] = []
  for (const mode of ['strict', 'lenient'] as const) {
    const labels = buildLabelsForQuery(row, mode)
    if (!Object.values(labels).some(v => v === 1)) continue
    const prodOrder = productionOrder(row)
    const jevOrder = jevV2Order(row)
    out.push({
      source: row.source,
      kind: row.kind,
      mode,
      production: metricsFor(prodOrder, labels),
      jev: metricsFor(jevOrder, labels),
      prodTop1: precisionAtK(prodOrder, labels, 1),
      jevTop1: precisionAtK(jevOrder, labels, 1),
    })
  }
  return out
}

// ── slicing + report (pure) ──────────────────────────────────────────────────

export function sliceRows(rows: QueryMetricRow[], mode: LabelMode): Record<string, QueryMetricRow[]> {
  const modeRows = rows.filter(r => r.mode === mode)
  const out: Record<string, QueryMetricRow[]> = { overall: modeRows }
  for (const source of ['eng', 'personal'] as const) out[`source:${source}`] = modeRows.filter(r => r.source === source)
  for (const kind of ['human', 'agent-payload'] as const) out[`kind:${kind}`] = modeRows.filter(r => r.kind === kind)
  return out
}

export interface BootstrapCI {
  mean: number
  lo: number
  hi: number
  iterations: number
}

/** `bootstrapDeltaCI` (imported from `eval-recall-evidence.ts`) divides by `n` inside its
 *  resampling loop and produces NaN for an empty slice (e.g. `source:personal` on an
 *  eng-only smoke run) — guarded here rather than in that file, which this script does not
 *  own. */
function safeCI(a: number[], b: number[]): BootstrapCI {
  if (a.length === 0) return { mean: 0, lo: 0, hi: 0, iterations: 0 }
  return bootstrapDeltaCI(a, b)
}

export interface SliceReport {
  slice: string
  n: number
  production: MetricSet
  jev: MetricSet
  wins: number
  losses: number
  ties: number
  ci: BootstrapCI
}

export function buildSliceReport(name: string, rows: QueryMetricRow[]): SliceReport {
  const wl = pairedWinsLosses(
    rows.map(r => r.jevTop1),
    rows.map(r => r.prodTop1)
  )
  return {
    slice: name,
    n: rows.length,
    production: meanMetricSet(rows.map(r => r.production)),
    jev: meanMetricSet(rows.map(r => r.jev)),
    wins: wl.wins,
    losses: wl.losses,
    ties: wl.ties,
    ci: safeCI(
      rows.map(r => r.jevTop1),
      rows.map(r => r.prodTop1)
    ),
  }
}

export function buildReport(rows: QueryMetricRow[]): Record<LabelMode, SliceReport[]> {
  const out = {} as Record<LabelMode, SliceReport[]>
  for (const mode of ['strict', 'lenient'] as const) {
    const slices = sliceRows(rows, mode)
    out[mode] = Object.entries(slices).map(([name, sliceRowsForName]) => buildSliceReport(name, sliceRowsForName))
  }
  return out
}

function fmt(x: number): string {
  return x.toFixed(4)
}
function signed(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(4)}`
}

export function renderReport(totalQueries: number, report: Record<LabelMode, SliceReport[]>): string {
  const lines: string[] = []
  lines.push('Recall relevance labelling — production vs Jev v2 (recall-shadow-policy/v2)')
  lines.push(`pool: ${totalQueries} labelled quer${totalQueries === 1 ? 'y' : 'ies'}`)
  lines.push('')
  for (const mode of ['strict', 'lenient'] as const) {
    lines.push(`== ${mode.toUpperCase()} (relevant = grade ${mode === 'strict' ? '== 2' : '>= 1'}) ==`)
    for (const s of report[mode]) {
      lines.push(`  [${s.slice}]  n=${s.n}`)
      if (s.n === 0) {
        lines.push('    (no judged queries in this slice)')
        continue
      }
      lines.push(`    production  P@1 ${fmt(s.production.p1)}  P@3 ${fmt(s.production.p3)}  nDCG@10 ${fmt(s.production.ndcg10)}  MRR ${fmt(s.production.mrr)}`)
      lines.push(`    jev_v2      P@1 ${fmt(s.jev.p1)}  P@3 ${fmt(s.jev.p3)}  nDCG@10 ${fmt(s.jev.ndcg10)}  MRR ${fmt(s.jev.mrr)}`)
      lines.push(
        `    paired top-1 (jev vs production): wins ${s.wins}  losses ${s.losses}  ties ${s.ties}` +
          `   bootstrap 95% CI Δ(P@1) ${signed(s.ci.mean)} [${signed(s.ci.lo)}, ${signed(s.ci.hi)}]  (${s.ci.iterations} resamples)`
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ── CLI args (pure) ──────────────────────────────────────────────────────────

export interface CliArgs {
  limit: number | null
  source: Source | 'all'
  reportOnly: boolean
  concurrency: number
}

export function parseArgs(argv: string[]): CliArgs {
  let limit: number | null = null
  let source: Source | 'all' = 'all'
  let reportOnly = false
  let concurrency = 1

  const takeValue = (i: number, flag: string): string => {
    const v = argv[i]
    if (v === undefined) throw new Error(`${flag} needs a value`)
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--limit') {
      limit = Number(takeValue(++i, '--limit'))
    } else if (a.startsWith('--limit=')) {
      limit = Number(a.slice('--limit='.length))
    } else if (a === '--source') {
      source = takeValue(++i, '--source') as Source | 'all'
    } else if (a.startsWith('--source=')) {
      source = a.slice('--source='.length) as Source | 'all'
    } else if (a === '--report-only') {
      reportOnly = true
    } else if (a === '--concurrency') {
      concurrency = Number(takeValue(++i, '--concurrency'))
    } else if (a.startsWith('--concurrency=')) {
      concurrency = Number(a.slice('--concurrency='.length))
    } else {
      throw new Error(`unrecognised argument: ${a}`)
    }
  }

  if (source !== 'eng' && source !== 'personal' && source !== 'all') {
    throw new Error(`--source must be eng|personal|all, got "${source}"`)
  }
  if (limit !== null && (!Number.isFinite(limit) || limit < 0)) {
    throw new Error(`--limit must be a non-negative number, got "${argv.join(' ')}"`)
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = 1

  return { limit, source, reportOnly, concurrency }
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
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()))
  return results
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })

  const existingRows = loadPoolRows(POOL_PATH)
  const doneKeys = alreadyDoneKeys(existingRows)

  if (!args.reportOnly) {
    const engText = fs.existsSync(ENG_LOG_PATH) ? fs.readFileSync(ENG_LOG_PATH, 'utf8') : ''
    const personalText = fs.existsSync(PERSONAL_LOG_PATH) ? fs.readFileSync(PERSONAL_LOG_PATH, 'utf8') : ''
    if (!engText) console.error(`warn: ${ENG_LOG_PATH} not found or empty`)
    if (!personalText) console.error(`warn: ${PERSONAL_LOG_PATH} not found or empty`)

    const allItems = collectAllQueries(engText, personalText)
    const inScope = args.source === 'all' ? allItems : allItems.filter(i => i.source === args.source)
    const pending = inScope.filter(i => !doneKeys.has(poolRowKey(i.source, i.query)))
    const toProcess = args.limit !== null ? pending.slice(0, args.limit) : pending

    console.error(
      `queries: ${allItems.length} distinct total (eng+personal), ${inScope.length} in scope for --source ${args.source}, ` +
        `${pending.length} not yet in the pool, processing ${toProcess.length} this run`
    )

    const gradeCache = loadGradeCache(GRADE_CACHE_PATH)
    if (fs.existsSync(PROTOTYPE_POOL_PATH)) {
      const seeded = seedGradeCacheFromPrototype(gradeCache, fs.readFileSync(PROTOTYPE_POOL_PATH, 'utf8'))
      if (seeded) console.error(`grade cache: seeded ${seeded} grade(s) from the 60-query prototype pool`)
    }
    const jevCache = loadJevCache(JEV_CACHE_PATH)

    const engine = createJevDecisionEngineFromEnv()
    if (!engine) console.error('warn: no Jev credential route (OneCLI gateway or TYPESAFE_API_KEY) — every candidate will be scored with jev=null')

    let engClient: MinimalMcpClient | null = null
    let personalClient: MinimalMcpClient | null = null
    if (toProcess.some(i => i.source === 'eng')) {
      engClient = new MinimalMcpClient(ENG_MCP_URL, null)
      await engClient.initialize()
    }
    if (toProcess.some(i => i.source === 'personal')) {
      personalClient = new MinimalMcpClient(PERSONAL_MCP_URL, null)
      await personalClient.initialize()
    }

    const pathCounts: Record<SearchOutcome['path'], number> = { bypass: 0, 'score-reconstructed': 0 }
    const perQuerySeconds: number[] = []
    let skipped = 0

    for (const item of toProcess) {
      const started = Date.now()
      const client = item.source === 'eng' ? engClient : personalClient
      if (!client) throw new Error(`no MCP client for source "${item.source}"`) // unreachable — client is built above for every source in toProcess

      let outcome: SearchOutcome
      try {
        outcome = await searchOneQueryWithRetry(client, item.query)
      } catch (e) {
        console.error(`skip ${queryTag(item.query)}: search failed: ${e instanceof Error ? e.message : String(e)}`)
        skipped++
        continue
      }
      pathCounts[outcome.path]++

      const cands = outcome.candidates.filter(c => c && typeof c.id === 'string' && typeof c.content === 'string').slice(0, TOPK)
      if (cands.length === 0) {
        console.error(`skip ${queryTag(item.query)}: 0 usable candidates`)
        skipped++
        continue
      }

      const targets = cands.map(c => {
        const content = capContent(c.content)
        return { c, content, key: labelCacheKey(item.query, c.id, content) }
      })

      await mapBounded(
        targets.filter(t => !gradeCache.has(t.key)),
        args.concurrency,
        async t => {
          const grade = await gemmaGrade(item.query, t.content)
          if (grade !== null) {
            gradeCache.set(t.key, grade)
            appendJsonLine(GRADE_CACHE_PATH, { key: t.key, grade })
          }
        }
      )

      const jevTargets = targets.filter(t => !jevCache.has(t.key))
      if (engine && jevTargets.length) {
        await Promise.all(
          jevTargets.map(async t => {
            try {
              const jev = await judgeCandidateV2(engine, item.query, { ...t.c, content: t.content })
              jevCache.set(t.key, jev)
              appendJsonLine(JEV_CACHE_PATH, { key: t.key, ...jev })
            } catch (e) {
              console.error(`jev failed for ${queryTag(item.query)} candidate ${t.c.id}: ${e instanceof Error ? e.message : String(e)}`)
            }
          })
        )
      }

      const candidateRows: PoolCandidateRow[] = targets.map((t, i) => ({
        id: t.c.id,
        prod_rank: i + 1,
        content: t.content,
        subject: t.c.metadata?.subject ?? null,
        sourceSystem: t.c.sourceSystem ?? (Array.isArray(t.c._sourceSystems) ? t.c._sourceSystems[0] : null) ?? null,
        grade: gradeCache.get(t.key) ?? null,
        jev: jevCache.get(t.key) ?? null,
      }))

      const poolRow: PoolRow = {
        query: item.query,
        source: item.source,
        kind: item.kind,
        at: new Date().toISOString(),
        production_path: outcome.path,
        candidates: candidateRows,
      }
      appendJsonLine(POOL_PATH, poolRow)
      existingRows.push(poolRow)
      doneKeys.add(poolRowKey(item.source, item.query))

      const elapsedS = (Date.now() - started) / 1000
      perQuerySeconds.push(elapsedS)
      const graded = candidateRows.filter(r => r.grade !== null).length
      const judged = candidateRows.filter(r => r.jev !== null).length
      console.error(
        `[${perQuerySeconds.length}/${toProcess.length}] ${queryTag(item.query)} (${item.source}/${item.kind}) ` +
          `— ${candidateRows.length} candidates, ${graded} graded, ${judged} jev-scored, path=${outcome.path}, ${elapsedS.toFixed(1)}s`
      )
    }

    if (engClient) await engClient.close()
    if (personalClient) await personalClient.close()

    console.error(
      `paths this run: bypass=${pathCounts.bypass} score-reconstructed=${pathCounts['score-reconstructed']}` +
        (skipped ? `  (${skipped} skipped)` : '')
    )
    if (perQuerySeconds.length) {
      const meanS = avg(perQuerySeconds)
      const totalS = perQuerySeconds.reduce((a, b) => a + b, 0)
      const remainingAfterThisRun = pending.length - toProcess.length
      console.error(
        `timing: ${perQuerySeconds.length} quer${perQuerySeconds.length === 1 ? 'y' : 'ies'} in ${totalS.toFixed(1)}s ` +
          `(mean ${meanS.toFixed(2)}s/query). ${remainingAfterThisRun} more not yet in the pool for --source ${args.source} ` +
          `(~${((remainingAfterThisRun * meanS) / 60).toFixed(1)} min at this rate); ` +
          `${allItems.length - existingRows.length} remaining across ALL sources ` +
          `(~${(((allItems.length - existingRows.length) * meanS) / 60).toFixed(1)} min at this rate)`
      )
    }
  }

  const allRows = args.reportOnly ? loadPoolRows(POOL_PATH) : existingRows

  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })
  const strictText = labelLinesForMode(allRows, 'strict').join('\n')
  const lenientText = labelLinesForMode(allRows, 'lenient').join('\n')
  fs.writeFileSync(LABELS_STRICT_PATH, allRows.length ? `${strictText}\n` : '', { mode: 0o600 })
  fs.writeFileSync(LABELS_LENIENT_PATH, allRows.length ? `${lenientText}\n` : '', { mode: 0o600 })

  const metricRows = allRows.flatMap(computeQueryMetrics)
  const report = buildReport(metricRows)
  console.log(renderReport(allRows.length, report))
}

// Only run when executed directly, not when imported by a test for its pure helpers.
if (process.argv[1] && process.argv[1].endsWith('label-recall-pool.ts')) {
  main().catch(e => {
    console.error('fatal:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
