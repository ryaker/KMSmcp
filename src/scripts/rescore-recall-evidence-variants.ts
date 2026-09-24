/**
 * Cache-only variant re-score for recall-evidence/v2 — ZERO Jev calls.
 *
 * Follow-up to `eval-recall-evidence.ts`'s gate run: that run showed v2-as-shipped losing
 * to v1 on the labelled pool, and flagged 65/1200 candidates with `contains_instruction`
 * above the demotion threshold. This answers "which of v2's rules is responsible" by
 * re-scoring the SAME cached Jev answers under five weight configurations, so the
 * comparison isolates the scoring formula from the model's judgments.
 *
 *   npx tsx src/scripts/rescore-recall-evidence-variants.ts
 *
 * Reads the pool and the on-disk answer cache written by `eval-recall-evidence.ts`
 * (`RECALL_EVAL_POOL_PATH` / `RECALL_EVAL_CACHE_PATH`, same defaults). If ANY
 * (query, candidate) pair is missing from the cache, this refuses to guess: it prints
 * every missing pair and exits 1 rather than silently scoring a partial set or falling
 * back to a live call.
 *
 * The five variants share the exact production constants from `shadowPolicy.ts`
 * (`SHADOW_WEIGHT_ANSWERS_QUERY`, `SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD`, etc.) — this
 * file does not hardcode a second copy of a weight the shipped policy already owns.
 *
 *   A  v2 as shipped                          (shadowScoreV2, unmodified)
 *   B  no instruction demotion                (drop the "> 0.7 -> 0" rule)
 *   C  no past-state discount                 (drop the "1 - 0.2p" multiplier)
 *   D  neither                                (base x correction multiplier only)
 *   E  base only                              (0.5*answers_query + 0.5*evidence/4, no multipliers)
 *
 * This script does not change `shadowScoreV2` or any default policy — it is read-only
 * analysis over the cache, run to inform a decision, not to ship one.
 */
import fs from 'fs'
import {
  EVIDENCE_VALUE_MAX,
  RECALL_EVIDENCE_V2_SCHEMA_VERSION,
  buildRecallStateV2,
  fingerprintRecallStateV2,
  type RecallCandidate,
} from '../decision/recallEvidence.js'
import {
  SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER,
  SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD,
  SHADOW_V2_PAST_STATE_DISCOUNT_WEIGHT,
  SHADOW_WEIGHT_ANSWERS_QUERY,
  SHADOW_WEIGHT_EVIDENCE_VALUE,
} from '../decision/shadowPolicy.js'
import {
  CACHE_PATH_ENV,
  DEFAULT_CACHE_PATH,
  DEFAULT_POOL_PATH,
  POOL_PATH_ENV,
  bootstrapDeltaCI,
  loadCache,
  loadPool,
  pairedWinsLosses,
  baseRanked,
  labelsFor,
  meanMetricSet,
  metricsFor,
  v1Order,
  type CachedAnswer,
  type MetricSet,
  type Mode,
  type PoolCandidate,
  type PoolQuery,
  type RankedCandidate,
} from './eval-recall-evidence.js'

// ── variant scoring — pure re-combination of the cached components ─────────────

export interface VariantConfig {
  id: string
  label: string
  applyInstructionDemotion: boolean
  applyPastStateDiscount: boolean
  applyCorrectionMultiplier: boolean
}

export const VARIANTS: readonly VariantConfig[] = [
  { id: 'A', label: 'v2 as shipped', applyInstructionDemotion: true, applyPastStateDiscount: true, applyCorrectionMultiplier: true },
  { id: 'B', label: 'no instruction demotion', applyInstructionDemotion: false, applyPastStateDiscount: true, applyCorrectionMultiplier: true },
  { id: 'C', label: 'no past-state discount', applyInstructionDemotion: true, applyPastStateDiscount: false, applyCorrectionMultiplier: true },
  { id: 'D', label: 'neither (base x correction multiplier only)', applyInstructionDemotion: false, applyPastStateDiscount: false, applyCorrectionMultiplier: true },
  { id: 'E', label: 'base only (no multipliers)', applyInstructionDemotion: false, applyPastStateDiscount: false, applyCorrectionMultiplier: false },
] as const

/**
 * `correctedOrReplaced` is always `false` here — same reason `eval-recall-evidence.ts`'s
 * v2Order hardcodes it: the pool carries no `metadata.flag` / `superseded_by`. That makes
 * D and E numerically identical on THIS pool (the only multiplier D applies never fires),
 * which the report calls out rather than hides.
 */
export function variantScore(a: CachedAnswer, cfg: VariantConfig, correctedOrReplaced = false): number {
  const evidence = Math.min(1, Math.max(0, a.evidence_value / EVIDENCE_VALUE_MAX))
  const base = SHADOW_WEIGHT_ANSWERS_QUERY * a.answers_query + SHADOW_WEIGHT_EVIDENCE_VALUE * evidence

  if (cfg.applyInstructionDemotion && a.contains_instruction > SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD) return 0

  const correctedMultiplier =
    cfg.applyCorrectionMultiplier && correctedOrReplaced ? SHADOW_V2_CORRECTED_OR_REPLACED_MULTIPLIER : 1
  const pastStateMultiplier = cfg.applyPastStateDiscount
    ? 1 - SHADOW_V2_PAST_STATE_DISCOUNT_WEIGHT * Math.min(1, Math.max(0, a.describes_past_state))
    : 1

  return Number((base * correctedMultiplier * pastStateMultiplier).toFixed(6))
}

function variantOrder(q: PoolQuery, answersById: ReadonlyMap<string, CachedAnswer>, cfg: VariantConfig): RankedCandidate[] {
  const withScore = baseRanked(q).map(c => {
    const a = answersById.get(c.id)
    // Every pair is required to be cached before this runs (see `main`), so `a` is always
    // present in practice; `-1` only matters if a caller reuses this against a partial map.
    return { c, score: a ? variantScore(a, cfg) : -1 }
  })
  return withScore.sort((x, y) => y.score - x.score).map(x => x.c)
}

// ── cache completeness check ────────────────────────────────────────────────

export interface MissingPair {
  queryIndex: number
  query: string
  candidateId: string
}

export function findCacheMisses(
  pool: PoolQuery[],
  cacheEntries: ReadonlyMap<string, CachedAnswer>
): { answersByQuery: Map<number, Map<string, CachedAnswer>>; missing: MissingPair[] } {
  const answersByQuery = new Map<number, Map<string, CachedAnswer>>()
  const missing: MissingPair[] = []

  pool.forEach((q, queryIndex) => {
    const byId = new Map<string, CachedAnswer>()
    for (const candidate of q.candidates) {
      const state = buildRecallStateV2(q.query, toRecallCandidate(candidate))
      const fingerprint = fingerprintRecallStateV2(state)
      const cached = cacheEntries.get(fingerprint)
      if (!cached) {
        missing.push({ queryIndex, query: q.query, candidateId: candidate.id })
        continue
      }
      byId.set(candidate.id, cached)
    }
    answersByQuery.set(queryIndex, byId)
  })

  return { answersByQuery, missing }
}

function toRecallCandidate(c: PoolCandidate): RecallCandidate {
  return { id: c.id, content: c.content, metadata: c.subject ? { subject: c.subject } : {} }
}

// ── report ───────────────────────────────────────────────────────────────────

interface VariantReport {
  cfg: VariantConfig
  table: Record<Mode, MetricSet>
  wins: number
  losses: number
  ties: number
  ci: ReturnType<typeof bootstrapDeltaCI>
}

function computeVariant(pool: PoolQuery[], answersByQuery: ReadonlyMap<number, Map<string, CachedAnswer>>, cfg: VariantConfig): VariantReport {
  const perMode: Record<Mode, MetricSet[]> = { strict: [], lenient: [] }
  const variantStrictP1: number[] = []
  const v1StrictP1: number[] = []

  pool.forEach((q, qi) => {
    const order = variantOrder(q, answersByQuery.get(qi) ?? new Map(), cfg)
    const v1 = v1Order(q)

    for (const mode of ['strict', 'lenient'] as const) {
      const labels = labelsFor(baseRanked(q), mode)
      perMode[mode].push(metricsFor(order, labels))
    }
    const strictLabels = labelsFor(baseRanked(q), 'strict')
    variantStrictP1.push(metricsFor(order, strictLabels).p1)
    v1StrictP1.push(metricsFor(v1, strictLabels).p1)
  })

  const wl = pairedWinsLosses(variantStrictP1, v1StrictP1)
  const ci = bootstrapDeltaCI(variantStrictP1, v1StrictP1)
  return {
    cfg,
    table: { strict: meanMetricSet(perMode.strict), lenient: meanMetricSet(perMode.lenient) },
    wins: wl.wins,
    losses: wl.losses,
    ties: wl.ties,
    ci,
  }
}

function fmt(x: number): string {
  return x.toFixed(4)
}
function signed(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(4)}`
}

const METRIC_ROWS = [
  ['P@1', 'p1'],
  ['P@3', 'p3'],
  ['nDCG@10', 'ndcg10'],
  ['MRR', 'mrr'],
] as const

function renderVariant(r: VariantReport, n: number): string {
  const lines: string[] = []
  lines.push(`## ${r.cfg.id} — ${r.cfg.label}`)
  for (const mode of ['strict', 'lenient'] as const) {
    lines.push(`  -- ${mode} (grade ${mode === 'strict' ? '== 2' : '>= 1'} counted relevant) --`)
    for (const [label, key] of METRIC_ROWS) {
      lines.push(`    ${label.padEnd(9)}  ${fmt(r.table[mode][key])}`)
    }
  }
  lines.push(`  paired top-1 (strict) vs v1: wins ${r.wins}, losses ${r.losses}, ties ${r.ties}  (n=${n})`)
  lines.push(
    `  bootstrap 95% CI, mean(P@1 variant - P@1 v1) strict: ${signed(r.ci.mean)}  [${signed(r.ci.lo)}, ${signed(r.ci.hi)}]  (${
      r.ci.iterations
    } resamples)`
  )
  return lines.join('\n')
}

// ── grade breakdown for the flagged instruction candidates ─────────────────

export interface GradeBreakdown {
  total: number
  grade2: number
  grade1: number
  grade0: number
}

export function instructionFlaggedGradeBreakdown(
  pool: PoolQuery[],
  answersByQuery: ReadonlyMap<number, Map<string, CachedAnswer>>
): GradeBreakdown {
  let grade2 = 0
  let grade1 = 0
  let grade0 = 0
  let total = 0

  pool.forEach((q, qi) => {
    const byId = answersByQuery.get(qi)
    if (!byId) return
    for (const candidate of q.candidates) {
      const a = byId.get(candidate.id)
      if (!a || a.contains_instruction <= SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD) continue
      total++
      if (candidate.grade === 2) grade2++
      else if (candidate.grade === 1) grade1++
      else grade0++
    }
  })

  return { total, grade2, grade1, grade0 }
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const poolPath = process.env[POOL_PATH_ENV]?.trim() || DEFAULT_POOL_PATH
  const cachePath = process.env[CACHE_PATH_ENV]?.trim() || DEFAULT_CACHE_PATH
  console.error(`pool: ${poolPath}`)
  console.error(`cache: ${cachePath} (read-only — zero Jev calls in this script)`)

  const pool = loadPool(poolPath)
  const totalPairs = pool.reduce((n, q) => n + q.candidates.length, 0)

  if (!fs.existsSync(cachePath)) {
    console.error(`fatal: cache file does not exist at ${cachePath} — nothing to re-score. Run eval-recall-evidence.ts first.`)
    process.exit(1)
  }
  const cache = loadCache(cachePath)
  if (cache.schema_version !== RECALL_EVIDENCE_V2_SCHEMA_VERSION || Object.keys(cache.entries).length === 0) {
    console.error(`fatal: cache at ${cachePath} is empty or the wrong schema version (${cache.schema_version}) — nothing to re-score.`)
    process.exit(1)
  }
  const cacheEntries = new Map(Object.entries(cache.entries))

  const { answersByQuery, missing } = findCacheMisses(pool, cacheEntries)
  if (missing.length > 0) {
    console.error(`fatal: ${missing.length}/${totalPairs} pairs are CACHE MISSES. Making zero Jev calls, as instructed. Stopping.`)
    for (const m of missing.slice(0, 20)) console.error(`  query#${m.queryIndex} candidate=${m.candidateId}`)
    if (missing.length > 20) console.error(`  ... and ${missing.length - 20} more`)
    process.exit(1)
  }
  console.error(`cache: ${totalPairs}/${totalPairs} pairs found — zero misses, zero Jev calls made`)

  const reports = VARIANTS.map(cfg => computeVariant(pool, answersByQuery, cfg))
  const grades = instructionFlaggedGradeBreakdown(pool, answersByQuery)

  console.log('Recall evidence v2 — variant re-score (cache only, zero new Jev calls)')
  console.log('')
  console.log(`pool: ${pool.length} queries x ${pool[0]?.candidates.length ?? 0} candidates = ${totalPairs} pairs, all served from cache`)
  console.log('')
  for (const r of reports) {
    console.log(renderVariant(r, pool.length))
    console.log('')
  }

  console.log(`contains_instruction > ${SHADOW_V2_INSTRUCTION_DEMOTE_THRESHOLD} — Gemma grade breakdown of the ${grades.total} flagged candidates:`)
  console.log(`  grade 2 (strict-relevant): ${grades.grade2}`)
  console.log(`  grade 1 (lenient-relevant only): ${grades.grade1}`)
  console.log(`  grade 0 (irrelevant): ${grades.grade0}`)
  const relevantShare = grades.total > 0 ? (grades.grade2 + grades.grade1) / grades.total : 0
  console.log(`  relevant (grade >= 1) share of flagged: ${(relevantShare * 100).toFixed(1)}%`)
}

if (process.argv[1] && process.argv[1].endsWith('rescore-recall-evidence-variants.ts')) {
  main().catch(e => {
    console.error('fatal:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
