/**
 * On-read shadow rerank metrics — the offline read of the decision log.
 *
 * The promote gate for bi-directional (production) reorder is a sample count: 100–200
 * on-read shadow runs. Counting them by hand is how a gate gets declared met on a partial
 * read, so the count and everything that qualifies it lives here.
 *
 * Pure: takes log text, returns numbers. Reading files and printing them is the CLI's job
 * (`src/scripts/shadow-eval-report.ts`) — the same split as `harvest/claudeTranscripts.ts`.
 *
 * Two kinds of number appear below, and they are not interchangeable:
 *
 *  - **Invariant** numbers (permutation, protection, provider faults) are falsifiable from
 *    the log alone. A non-zero one is a defect at any sample count — it does not need
 *    labels, and adding more samples cannot make it acceptable.
 *  - **Quality** numbers (top-k agreement, displacement) describe how much the policy
 *    *would* change what a reader sees. They say nothing about whether the change is an
 *    improvement. That requires relevance labels the store does not have; see
 *    `labelAgreement` and the promote checklist.
 */

import crypto from 'crypto'
import { protectionReason } from '../decision/shadowPolicy.js'
import { precisionAtK, ndcgAtK, reciprocalRank, type EvalCandidate } from './rankers.js'
import type { ShadowRunRecord } from '../decision/decisionLog.js'

// ── parsing ──────────────────────────────────────────────────────────────────

export interface ParsedShadowLog {
  rows: ShadowRunRecord[]
  /** Lines that did not parse, or parsed as something other than a recall run. */
  malformedLines: number
  /**
   * A final line with no trailing newline that failed to parse. On a live log this is the
   * append currently in flight, not corruption — counted apart from `malformedLines` so a
   * concurrent writer does not read as a data problem.
   */
  partialTailLines: number
  /** Parsed runs whose action was `shadow_log`: no ordering was computed, so nothing to compare. */
  unorderedRuns: number
}

/**
 * Lenient by design. These files are appended to by a running daemon and read by an
 * operator mid-write, so a reader that throws on one bad byte cannot report on a log that
 * is 99.9% good. Rows are validated only to the depth the metrics actually depend on.
 */
export function parseShadowLog(text: string): ParsedShadowLog {
  const rows: ShadowRunRecord[] = []
  let malformedLines = 0
  let partialTailLines = 0
  let unorderedRuns = 0

  const lines = text.split('\n')
  const tailIsPartial = text.length > 0 && !text.endsWith('\n')

  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    const isTail = tailIsPartial && i === lines.length - 1
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      if (isTail) partialTailLines++
      else malformedLines++
      return
    }
    const r = row as Partial<ShadowRunRecord>
    if (!r || r.kind !== 'recall_shadow_run' || !Array.isArray(r.production_order)) {
      malformedLines++
      return
    }
    if (!Array.isArray(r.shadow_order)) {
      unorderedRuns++
      return
    }
    rows.push(r as ShadowRunRecord)
  })

  return { rows, malformedLines, partialTailLines, unorderedRuns }
}

// ── ordering ─────────────────────────────────────────────────────────────────

/** First index wins if an id repeats — a duplicate is a defect the counters below surface. */
function rankMap(order: string[]): Map<string, number> {
  const m = new Map<string, number>()
  order.forEach((id, i) => {
    if (!m.has(id)) m.set(id, i)
  })
  return m
}

export interface OrderingMetrics {
  runs: number
  identical: number
  reordered: number
  /** Share of runs where the shadow ordering differs from what production served. */
  reorderRate: number
  /** Share of runs with the same candidate at rank 1. */
  top1Agreement: number
  /** Share of runs whose top-3 is the same *set* (any internal order). */
  top3SetEqual: number
  /** Mean |top-3(A) ∩ top-3(B)| / 3 — the set-equality figure alone hides near-misses. */
  meanTop3Overlap: number
  /** Mean absolute rank displacement per candidate, averaged over runs. */
  meanDisplacement: number
  maxDisplacement: number
  /** Runs whose shadow_order is not a permutation of production_order. Must be 0. */
  permutationViolations: number
  emptyRuns: number
}

export function orderingMetrics(rows: ShadowRunRecord[]): OrderingMetrics {
  let identical = 0
  let top1 = 0
  let top3Set = 0
  let overlap3 = 0
  let permutations = 0
  let empty = 0
  let displacementSum = 0
  let displacementN = 0
  let maxDisplacement = 0

  for (const r of rows) {
    const prod = r.production_order
    const shadow = r.shadow_order as string[]
    if (!prod.length || !shadow.length) {
      empty++
      continue
    }

    if (sortedEqual(prod, shadow) === false) permutations++

    if (prod.length === shadow.length && prod.every((id, i) => id === shadow[i])) identical++
    if (prod[0] === shadow[0]) top1++

    const p3 = new Set(prod.slice(0, 3))
    const s3 = new Set(shadow.slice(0, 3))
    let inter = 0
    for (const id of s3) if (p3.has(id)) inter++
    overlap3 += inter / 3
    if (inter === 3 && p3.size === s3.size) top3Set++

    const pm = rankMap(prod)
    let runMax = 0
    for (let i = 0; i < shadow.length; i++) {
      const at = pm.get(shadow[i])
      if (at === undefined) continue
      const d = Math.abs(at - i)
      displacementSum += d
      displacementN++
      if (d > runMax) runMax = d
    }
    if (runMax > maxDisplacement) maxDisplacement = runMax
  }

  const runs = rows.length
  const nonEmpty = runs - empty
  return {
    runs,
    identical,
    reordered: runs - identical,
    reorderRate: runs ? (runs - identical) / runs : 0,
    top1Agreement: runs ? top1 / runs : 0,
    top3SetEqual: runs ? top3Set / runs : 0,
    meanTop3Overlap: nonEmpty ? overlap3 / nonEmpty : 0,
    meanDisplacement: displacementN ? displacementSum / displacementN : 0,
    maxDisplacement,
    permutationViolations: permutations,
    emptyRuns: empty
  }
}

function sortedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

// ── protection invariant ─────────────────────────────────────────────────────

export interface ProtectionViolation {
  runId: string
  candidateId: string
  reason: string
  productionRank: number
  shadowRank: number
}

export interface ProtectionAudit {
  candidates: number
  /** Candidates the policy marked protected, per its two thresholds. */
  fired: number
  byReason: Record<string, number>
  /**
   * Logged `policy_protected` re-derived from the logged retrieval signals. Non-zero means
   * the flag and the signals it claims to come from have drifted apart — which would make
   * every violation count below unsound, so it is checked before they are trusted.
   */
  disagreements: number
  disagreementExamples: string[]
  /** Invariant 2 breaches: a pinned candidate placed BELOW its production position. */
  violations: ProtectionViolation[]
  /** Run ids where a breach was found, for a targeted re-read. */
  violatedRuns: string[]
}

/**
 * The protection rule is the one part of the shadow ordering that is a promise rather than
 * a preference: a strong deterministic/ontology match may be promoted, never demoted
 * (`shadowPolicy.shadowOrder` invariant 2). It is unit-tested, but unit tests cannot say
 * whether it has ever fired against real data — `fired: 0` over a large corpus is itself a
 * finding, because it means the invariant is unexercised outside the test suite.
 */
export function protectionAudit(rows: ShadowRunRecord[]): ProtectionAudit {
  const byReason: Record<string, number> = {}
  const violations: ProtectionViolation[] = []
  const violatedRuns = new Set<string>()
  const disagreementExamples: string[] = []
  let candidates = 0
  let fired = 0
  let disagreements = 0

  for (const r of rows) {
    const shadow = r.shadow_order as string[]
    const sm = rankMap(shadow)
    for (const c of r.candidates ?? []) {
      candidates++
      const logged = c.policy_protected
      if (logged) {
        fired++
        byReason[logged] = (byReason[logged] ?? 0) + 1
      }

      const derived = protectionReason({
        _ontologyScore: c.retrieval?.ontology_score,
        _relevance: c.retrieval?.retrieval_relevance
      } as never)
      if ((derived ?? null) !== (logged ?? null)) {
        disagreements++
        if (disagreementExamples.length < 3) {
          disagreementExamples.push(`${r.run_id}/${c.id}: logged=${logged} derived=${derived}`)
        }
      }

      if (!logged) continue
      const at = sm.get(c.id)
      if (at === undefined) continue
      const prod = (c.production_rank ?? 0) - 1
      if (at > prod) {
        violations.push({
          runId: r.run_id,
          candidateId: c.id,
          reason: logged,
          productionRank: c.production_rank,
          shadowRank: at + 1
        })
        violatedRuns.add(r.run_id)
      }
    }
  }

  return {
    candidates,
    fired,
    byReason,
    disagreements,
    disagreementExamples,
    violations,
    violatedRuns: [...violatedRuns]
  }
}

// ── latency / cost / provider health ─────────────────────────────────────────

export interface RunTotals {
  runs: number
  totalLatencyMs: number
  meanLatencyMs: number
  p50LatencyMs: number
  p95LatencyMs: number
  maxLatencyMs: number
  totalCostUsd: number
  meanCostUsd: number
  /** Runs carrying a cost estimate. A short count means the price env vars were unset. */
  costedRuns: number
  totalInputTokens: number
  totalOutputTokens: number
  candidatesEvaluated: number
  /** Sum of each run's `candidates_failed`. Must be 0 for a clean gate read. */
  candidatesFailed: number
  /** Per-candidate `error` strings, which is where a provider fault actually lands. */
  candidateErrors: number
  meanCandidateLatencyMs: number
}

export function runTotals(rows: ShadowRunRecord[]): RunTotals {
  const latencies: number[] = []
  let totalCost = 0
  let costed = 0
  let inTok = 0
  let outTok = 0
  let evaluated = 0
  let failed = 0
  let errors = 0
  let candLatency = 0
  let candN = 0

  for (const r of rows) {
    if (typeof r.latency_ms === 'number') latencies.push(r.latency_ms)
    if (typeof r.cost_usd_estimate === 'number') {
      totalCost += r.cost_usd_estimate
      costed++
    }
    inTok += r.usage?.input_tokens ?? 0
    outTok += r.usage?.output_tokens ?? 0
    evaluated += r.candidates_evaluated ?? 0
    failed += r.candidates_failed ?? 0
    for (const c of r.candidates ?? []) {
      if (c.error) errors++
      if (typeof c.latency_ms === 'number') {
        candLatency += c.latency_ms
        candN++
      }
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b)
  const totalLatency = latencies.reduce((a, b) => a + b, 0)
  return {
    runs: rows.length,
    totalLatencyMs: totalLatency,
    meanLatencyMs: latencies.length ? totalLatency / latencies.length : 0,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    maxLatencyMs: sorted.length ? sorted[sorted.length - 1] : 0,
    totalCostUsd: totalCost,
    meanCostUsd: costed ? totalCost / costed : 0,
    costedRuns: costed,
    totalInputTokens: inTok,
    totalOutputTokens: outTok,
    candidatesEvaluated: evaluated,
    candidatesFailed: failed,
    candidateErrors: errors,
    meanCandidateLatencyMs: candN ? candLatency / candN : 0
  }
}

/** Nearest-rank. Returns 0 for an empty set rather than NaN — a NaN would read as a real number. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

// ── sample rate → the gate ───────────────────────────────────────────────────

export interface RateProjection {
  firstAt: string | null
  lastAt: string | null
  windowHours: number
  runsPerDay: number
  target: number
  remaining: number
  /** Null when the observed window is too short to extrapolate from. */
  etaHours: number | null
  etaAt: string | null
  perUtcDay: Record<string, number>
}

/**
 * ETA is extrapolation from a window that spans hours, not weeks — it assumes sampling
 * continues at the observed rate. Reported as a number with that caveat attached rather
 * than as a promise.
 */
export function rateProjection(
  rows: ShadowRunRecord[],
  target: number,
  now = new Date()
): RateProjection {
  const perUtcDay: Record<string, number> = {}
  const times: number[] = []
  for (const r of rows) {
    if (typeof r.at !== 'string') continue
    const t = Date.parse(r.at)
    if (Number.isNaN(t)) continue
    times.push(t)
    const day = r.at.slice(0, 10)
    perUtcDay[day] = (perUtcDay[day] ?? 0) + 1
  }

  const runs = rows.length
  const remaining = Math.max(0, target - runs)
  if (!times.length) {
    return {
      firstAt: null,
      lastAt: null,
      windowHours: 0,
      runsPerDay: 0,
      target,
      remaining,
      etaHours: null,
      etaAt: null,
      perUtcDay
    }
  }

  const first = Math.min(...times)
  const last = Math.max(...times)
  const windowHours = (last - first) / 3_600_000
  const runsPerDay = windowHours > 0 ? (runs / windowHours) * 24 : 0
  // Below an hour of observation the per-day figure is noise; say so with a null ETA.
  const measurable = windowHours >= 1 && runsPerDay > 0
  const etaHours = measurable ? remaining / (runsPerDay / 24) : null

  return {
    firstAt: new Date(first).toISOString(),
    lastAt: new Date(last).toISOString(),
    windowHours,
    runsPerDay,
    target,
    remaining,
    etaHours,
    etaAt: etaHours === null ? null : new Date(now.getTime() + etaHours * 3_600_000).toISOString(),
    perUtcDay
  }
}

// ── label join (only if real labels exist) ───────────────────────────────────

/** Relevance for one query: candidate id → 1 (relevant) | 0 (marginal/irrelevant). */
export type QueryLabels = Record<string, number>
/** Keyed by the run's `query` text, trimmed. */
export type LabelSet = Record<string, QueryLabels>

/**
 * Two accepted shapes, because a judging pass may be produced per-run or as one blob:
 *
 *   JSONL:  {"query": "...", "labels": {"<candidate-id>": 1}}
 *   JSON :  {"<query>": {"<candidate-id>": 1}}
 *
 * Disambiguating them is not just a `startsWith('{')` check: a file holding a SINGLE JSONL
 * row is itself valid JSON, and reading it as the keyed-object shape would silently turn its
 * `labels` key into a query named "labels". So the row shape is recognised explicitly, and
 * the keyed shape is accepted only when every value is a score map.
 *
 * Returns an empty set for empty input — the caller distinguishes "not provided" (no file)
 * from "provided and empty", because the first is the normal state today and the second is
 * a broken judging pass.
 */
export function parseLabels(text: string): LabelSet {
  const out: LabelSet = {}
  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    let obj: unknown = null
    try {
      obj = JSON.parse(trimmed)
    } catch {
      obj = null // Not a single JSON object — fall through and try it as JSONL.
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const map = obj as Record<string, unknown>
      const row = asLabelRow(map)
      if (row) {
        out[row.query] = row.labels
        return out
      }
      const entries = Object.entries(map)
      if (entries.length && entries.every(([, v]) => isScoreMap(v))) {
        for (const [q, l] of entries) out[q] = l as QueryLabels
        return out
      }
      // Valid JSON but neither shape — fall through so the JSONL reader can say why.
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`labels: line is not JSON: ${line.slice(0, 80)}`)
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = asLabelRow(parsed as Record<string, unknown>)
      if (row) out[row.query] = row.labels
    }
  }
  return out
}

/** `{query: string, labels: {id: number}}` — one judged run. */
function asLabelRow(o: Record<string, unknown>): { query: string; labels: QueryLabels } | null {
  if (typeof o.query !== 'string' || !isScoreMap(o.labels)) return null
  return { query: o.query, labels: o.labels as QueryLabels }
}

function isScoreMap(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(x => typeof x === 'number')
}

export interface LabelScores {
  precisionAtK: number
  ndcgAtK: number
  reciprocalRank: number
  /** Mean 1-based rank of the first relevant hit; 0 when none was found. */
  meanFirstRelevantRank: number
}

export interface LabelAgreement {
  k: number
  labeledRuns: number
  /** Runs whose query has no label entry — excluded from every number above, and counted. */
  unlabeledRuns: number
  production: LabelScores
  shadow: LabelScores
  delta: { precisionAtK: number; ndcgAtK: number; reciprocalRank: number }
}

/**
 * Scores the shadow ordering against the production ordering on the runs that carry
 * labels. Returns **null** when no run has labels.
 *
 * That null is the honest answer today and the caller must render it as "not computed",
 * never as 0 or as a win: KMS has no relevance labels for these queries. The Harvest
 * Phase 0 pipeline stores Rich's *corrections, rules and preferences* — label statements
 * about how to work, addressed to no candidate id — so joining them to a recall run would
 * be inventing a relevance judgment, which is precisely what this metric must not do.
 * A `LabelSet` has to come from a real judging pass (or from the frozen-pool eval harness
 * in `src/eval/rankers.ts`) before this can say anything about quality.
 */
export function labelAgreement(
  rows: ShadowRunRecord[],
  labels: LabelSet,
  k: number
): LabelAgreement | null {
  const byQuery = new Map<string, QueryLabels>()
  for (const [q, l] of Object.entries(labels)) byQuery.set(q.trim(), l)

  const prod: LabelScores[] = []
  const shadow: LabelScores[] = []
  let unlabeled = 0

  for (const r of rows) {
    const l = byQuery.get(String(r.query ?? '').trim())
    if (!l) {
      unlabeled++
      continue
    }
    const toCands = (ids: string[]): EvalCandidate[] => ids.map(id => ({ id, content: '' }))
    prod.push(scoreOrdering(toCands(r.production_order), l, k))
    shadow.push(scoreOrdering(toCands(r.shadow_order as string[]), l, k))
  }

  if (!prod.length) return null

  const mean = (xs: LabelScores[]): LabelScores => ({
    precisionAtK: avg(xs.map(x => x.precisionAtK)),
    ndcgAtK: avg(xs.map(x => x.ndcgAtK)),
    reciprocalRank: avg(xs.map(x => x.reciprocalRank)),
    meanFirstRelevantRank: avg(xs.map(x => x.meanFirstRelevantRank))
  })

  const p = mean(prod)
  const s = mean(shadow)
  return {
    k,
    labeledRuns: prod.length,
    unlabeledRuns: unlabeled,
    production: p,
    shadow: s,
    delta: {
      precisionAtK: s.precisionAtK - p.precisionAtK,
      ndcgAtK: s.ndcgAtK - p.ndcgAtK,
      reciprocalRank: s.reciprocalRank - p.reciprocalRank
    }
  }
}

function scoreOrdering(ordered: EvalCandidate[], labels: QueryLabels, k: number): LabelScores {
  const first = ordered.findIndex(c => labels[c.id] === 1)
  return {
    precisionAtK: precisionAtK(ordered, labels, k),
    ndcgAtK: ndcgAtK(ordered, labels, k),
    reciprocalRank: reciprocalRank(ordered, labels),
    meanFirstRelevantRank: first === -1 ? 0 : first + 1
  }
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

// ── summary ──────────────────────────────────────────────────────────────────

export interface ShadowEvalSummary {
  ordering: OrderingMetrics
  protection: ProtectionAudit
  totals: RunTotals
  rate: RateProjection
  labels: LabelAgreement | null
  malformedLines: number
  partialTailLines: number
  unorderedRuns: number
  models: Record<string, number>
  policyVersions: Record<string, number>
  providers: Record<string, number>
}

export function summarize(
  rows: ShadowRunRecord[],
  opts: {
    target?: number
    labels?: LabelSet | null
    k?: number
    now?: Date
  } = {}
): ShadowEvalSummary {
  const target = opts.target ?? 200
  const k = opts.k ?? 5
  return {
    ordering: orderingMetrics(rows),
    protection: protectionAudit(rows),
    totals: runTotals(rows),
    rate: rateProjection(rows, target, opts.now ?? new Date()),
    labels: opts.labels ? labelAgreement(rows, opts.labels, k) : null,
    malformedLines: 0,
    partialTailLines: 0,
    unorderedRuns: 0,
    models: tally(rows.flatMap(r => r.models ?? [])),
    policyVersions: tally(rows.map(r => r.policy_version)),
    providers: tally(rows.map(r => r.provider))
  }
}

function tally(xs: (string | undefined | null)[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const x of xs) {
    if (typeof x !== 'string' || !x) continue
    out[x] = (out[x] ?? 0) + 1
  }
  return out
}

// ── rendering ────────────────────────────────────────────────────────────────

export interface SourceReadout {
  label: string
  file: string
  parsed: ParsedShadowLog | null
}

function sha12(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function hours_(h: number): string {
  return h >= 1 ? `${h.toFixed(1)} h` : `${(h * 60).toFixed(0)} min`
}

function section(title: string, rows: [string, string][]): string {
  const w = Math.max(...rows.map(([k]) => k.length))
  return [title, ...rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`)].join('\n')
}

/**
 * Renders the summary. Three deliberate choices, each of which a reader could otherwise
 * get wrong from the numbers alone:
 *
 *  - QUALITY is titled as "how much would change", never "improvement". A 98% reorder rate
 *    is not a gain; without labels it is only a measure of blast radius.
 *  - "labels: NONE" is printed as an explicit absence, so nobody reads the missing delta
 *    as a zero.
 *  - Query text never appears. The log is 0600 because a query may carry a credential, so
 *    unmatched label keys are reported by hash and length.
 */
export function renderReport(
  sources: SourceReadout[],
  combined: ShadowEvalSummary,
  meta: { labelSetProvided: boolean }
): string {
  const out: string[] = []
  out.push('Jev on-read shadow eval — recall rerank (Experiment 1)')
  out.push('')

  const srcRows: [string, string][] = sources.map(s => [
    s.label,
    s.parsed ? `runs=${s.parsed.rows.length}  ${s.file}` : `MISSING  ${s.file}`
  ])
  srcRows.push(['combined', `runs=${combined.ordering.runs}`])
  out.push(section('logs', srcRows))
  out.push('')

  const r = combined.rate
  out.push(
    section('GATE — sample count', [
      ['runs', `${combined.ordering.runs} / ${r.target} target   (${r.remaining} remaining)`],
      [
        'observed window',
        r.firstAt
          ? `${hours_(r.windowHours)}  (${r.firstAt} -> ${r.lastAt})`
          : 'no timestamped runs'
      ],
      ['rate', r.runsPerDay ? `${r.runsPerDay.toFixed(1)} runs/day` : 'n/a'],
      [
        'ETA to target',
        r.etaAt
          ? `~${hours_(r.etaHours ?? 0)}  (${r.etaAt}) — extrapolated from the window above`
          : 'not measurable yet (window under 1 h)'
      ],
      [
        'skipped',
        `${combined.unorderedRuns} shadow-log-only, ${combined.malformedLines} malformed, ${combined.partialTailLines} partial tail`
      ]
    ])
  )
  out.push('')

  const o = combined.ordering
  const qRows: [string, string][] = [
    [
      'reordered',
      `${o.reordered}/${o.runs}  (${pct(o.reorderRate)}) — shadow order differs from what production served`
    ],
    ['top-1 agreement', pct(o.top1Agreement)],
    ['top-3 overlap', `${pct(o.meanTop3Overlap)} mean   (set-equal ${pct(o.top3SetEqual)})`],
    ['mean |rank Δ|', `${o.meanDisplacement.toFixed(2)}   max ${o.maxDisplacement}`],
    [
      'labels',
      meta.labelSetProvided
        ? 'provided'
        : 'NONE — quality delta NOT computed (no relevance labels exist for these queries)'
    ]
  ]
  if (combined.labels) {
    const l = combined.labels
    const d = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`
    qRows.push([
      `P@${l.k}`,
      `prod ${l.production.precisionAtK.toFixed(4)}  shadow ${l.shadow.precisionAtK.toFixed(4)}  Δ ${d(l.delta.precisionAtK)}`
    ])
    qRows.push([
      `nDCG@${l.k}`,
      `prod ${l.production.ndcgAtK.toFixed(4)}  shadow ${l.shadow.ndcgAtK.toFixed(4)}  Δ ${d(l.delta.ndcgAtK)}`
    ])
    qRows.push([
      'MRR',
      `prod ${l.production.reciprocalRank.toFixed(4)}  shadow ${l.shadow.reciprocalRank.toFixed(4)}  Δ ${d(l.delta.reciprocalRank)}`
    ])
    qRows.push([
      'labeled runs',
      `${l.labeledRuns} labeled, ${l.unlabeledRuns} unlabeled (excluded)`
    ])
  }
  out.push(section('QUALITY — how much the policy would change; NOT whether it is better', qRows))
  out.push('')

  const p = combined.protection
  out.push(
    section('INVARIANTS — must hold at any sample count', [
      [
        'permutation',
        `${o.permutationViolations} violations (shadow must be a permutation of production)`
      ],
      [
        'protection',
        `${p.violations.length} violations — pinned candidates placed below production position`
      ],
      ['protection fired', `${p.fired}/${p.candidates} candidates  ${JSON.stringify(p.byReason)}`],
      [
        'signal consistency',
        `${p.disagreements} disagreements between logged policy_protected and retrieval signals`
      ],
      [
        'provider',
        `${combined.totals.candidateErrors} candidate errors, ${combined.totals.candidatesFailed} failed`
      ]
    ])
  )
  if (p.fired === 0 && p.candidates > 0) {
    out.push(
      `  NOTE: the protection rule never fired across ${p.candidates} candidates, so invariant 2 is`
    )
    out.push(
      '        unexercised on live data (unit-tested only). Check the thresholds before promoting.'
    )
  }
  for (const d of p.disagreementExamples) out.push(`  disagreement: ${d}`)
  out.push('')

  const t = combined.totals
  out.push(
    section('COST / LATENCY', [
      [
        'run latency',
        `mean ${t.meanLatencyMs.toFixed(0)} ms  p50 ${t.p50LatencyMs}  p95 ${t.p95LatencyMs}  max ${t.maxLatencyMs}`
      ],
      [
        'candidate latency',
        `mean ${t.meanCandidateLatencyMs.toFixed(0)} ms  (${t.candidatesEvaluated} evaluated)`
      ],
      [
        'cost',
        `$${t.totalCostUsd.toFixed(4)} total  $${t.meanCostUsd.toFixed(6)}/run  (${t.costedRuns}/${t.runs} runs costed)`
      ],
      ['tokens', `${t.totalInputTokens} in / ${t.totalOutputTokens} out`],
      ['models', JSON.stringify(combined.models)],
      ['policy', JSON.stringify(combined.policyVersions)],
      ['provider', JSON.stringify(combined.providers)]
    ])
  )
  out.push('')
  out.push('Reminder: shadow-only. Nothing here changes what unified_search returns.')
  return out.join('\n')
}

/**
 * Label keys that matched no run — usually a whitespace or truncation mismatch, worth
 * seeing without printing the query. Hash and length only; see `renderReport`.
 */
export function unmatchedLabelKeys(labels: LabelSet, rows: ShadowRunRecord[]): string[] {
  const keys = new Set(rows.map(r => String(r.query ?? '').trim()))
  return Object.keys(labels)
    .filter(q => !keys.has(q.trim()))
    .map(q => `sha256:${sha12(q.trim())}  len=${q.trim().length}`)
}
