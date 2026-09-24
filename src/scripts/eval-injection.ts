/**
 * Offline eval: does a Jev noul flag a stored KMS memory as a prompt-injection risk without
 * over-firing on the legitimate standing rules users write for their own agents?
 *
 * Background: `contains_instruction` (RECALL_EVIDENCE_QUESTIONS_V2, src/decision/recallEvidence.ts)
 * was the first attempt. On the 1,200-pair recall-evidence eval, 65 candidates scored it above
 * 0.7, and 61.5% of those were RELEVANT — legitimate rules like "never run Ollama on this Mac
 * mini". This script scores every variant in `src/eval/injectionQuestions.ts` against a labelled
 * dataset (`src/eval/injectionDataset.ts`) and recommends the one that best separates real
 * injections from legitimate stored rules, with an operating threshold.
 *
 *   doppler run --project ry-local --config dev_eng -- npx tsx src/scripts/eval-injection.ts
 *   doppler run --project ry-local --config dev_eng -- npx tsx src/scripts/eval-injection.ts --report-only
 *
 * Every (variant, sample) pair calls Jev once through `createJevDecisionEngineFromEnv()` and
 * `withEngineSlot` — the same production 15 rps token bucket every other decision path shares,
 * so this script's burst makes no more demand on the credential than a handful of real searches
 * would. Submission is bounded to 40 in flight (`mapBounded`) so the shared bucket's queue
 * (`JEV_ENGINE_QUEUE_MAX` = 100) never backs up. Raw per-question answers are cached to disk,
 * one file per variant (`~/.kms/eval-cache/injection-<variant-id>.json`), keyed by a fingerprint
 * of exactly what the engine was shown — so `--report-only` recomputes every metric with zero
 * further calls, and re-running after a wording change only pays for the changed variant.
 *
 * Dataset assembly (see injectionDataset.ts for the full slice-by-slice contract):
 *   - synthetic positives + synthetic hard negatives: committed fixtures.
 *   - deepset/prompt-injections positives: downloaded once at runtime, cached, NOT committed.
 *   - real negatives: a seeded sample of real SparrowDB content-index sidecar entries, NEVER
 *     committed and NEVER printed — this report surfaces ids and counts only.
 *
 * ASSUMPTION (stated per the task brief, repeated in docs/eval/prompt-injection-eval.md): the
 * real corpus sampled here contains no actual injections, so every real sample is ground-truth
 * negative for this eval's purposes.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createJevDecisionEngineFromEnv } from '../decision/JevDecisionEngine.js'
import { withEngineSlot } from '../decision/engineSlot.js'
import { fingerprintState } from '../decision/stateFingerprint.js'
import type { DecisionJson } from '../decision/types.js'
import {
  INJECTION_EVAL_SCHEMA_VERSION,
  INJECTION_VARIANTS,
  type InjectionVariantSpec,
} from '../eval/injectionQuestions.js'
import {
  loadDeepsetPositives,
  loadSyntheticHardNegatives,
  loadSyntheticPositives,
  sampleRealNegatives,
  type InjectionSample,
  type RealNegativeStoreCounts,
} from '../eval/injectionDataset.js'
import { fprAt, recallAt, recallByCategory, rocAuc, thresholdForFpr } from '../eval/injectionMetrics.js'

// ── cache ────────────────────────────────────────────────────────────────────

export interface CachedVariantAnswer {
  /** Question id -> P(yes). */
  probabilities: Record<string, number>
  /** max() over `probabilities` — the variant's combined injection score. */
  score: number
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd_estimate: number | null
}

export interface VariantCacheFile {
  schema_version: string
  variant_id: string
  entries: Record<string, CachedVariantAnswer>
}

export const CACHE_DIR_ENV = 'INJECTION_EVAL_CACHE_DIR'
export const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.kms', 'eval-cache')

export function cachePathForVariant(variantId: string, cacheDir: string = DEFAULT_CACHE_DIR): string {
  return path.join(cacheDir, `injection-${variantId}.json`)
}

export function loadVariantCache(filePath: string, variantId: string): VariantCacheFile {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as VariantCacheFile
    if (raw.schema_version === INJECTION_EVAL_SCHEMA_VERSION && raw.variant_id === variantId && raw.entries) {
      return raw
    }
    console.error(`cache: ${filePath} is stale (schema/variant mismatch); starting fresh`)
  } catch {
    // No cache file yet, or unreadable — start fresh.
  }
  return { schema_version: INJECTION_EVAL_SCHEMA_VERSION, variant_id: variantId, entries: {} }
}

function saveVariantCache(filePath: string, cache: VariantCacheFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, JSON.stringify(cache), { mode: 0o600 })
}

// ── bounded concurrency (same shape as eval-recall-evidence.ts's mapBounded) ─

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

// ── state building ───────────────────────────────────────────────────────────

export function buildVariantState(variant: InjectionVariantSpec, entry: string): DecisionJson {
  return variant.useCandidateContentState ? { candidate: { content: entry } } : { entry }
}

export function fingerprintVariantState(variant: InjectionVariantSpec, state: DecisionJson): string {
  return fingerprintState({ variant: variant.id, state } as DecisionJson)
}

// ── evaluation (the only place that calls Jev) ──────────────────────────────

interface Pair {
  variant: InjectionVariantSpec
  sample: InjectionSample
}

interface EvalResult {
  pair: Pair
  answer: CachedVariantAnswer | null
  error: string | null
  fromCache: boolean
}

async function evaluateAll(
  samples: InjectionSample[],
  variants: readonly InjectionVariantSpec[],
  cacheDir: string
): Promise<{ results: EvalResult[]; newCalls: number }> {
  const engine = createJevDecisionEngineFromEnv()
  if (!engine) {
    console.error('jev: no credential route (OneCLI gateway or TYPESAFE_API_KEY) — every uncached pair will fail')
  }

  const caches = new Map<string, VariantCacheFile>()
  for (const variant of variants) caches.set(variant.id, loadVariantCache(cachePathForVariant(variant.id, cacheDir), variant.id))

  const pairs: Pair[] = []
  for (const variant of variants) for (const sample of samples) pairs.push({ variant, sample })

  let newCalls = 0
  let sinceFlush = 0

  const results = await mapBounded(pairs, 40, async (pair): Promise<EvalResult> => {
    const { variant, sample } = pair
    const cache = caches.get(variant.id)!
    const state = buildVariantState(variant, sample.content)
    const fingerprint = fingerprintVariantState(variant, state)
    const cached = cache.entries[fingerprint]
    if (cached) return { pair, answer: cached, error: null, fromCache: true }

    if (!engine) return { pair, answer: null, error: 'no Jev credential route', fromCache: false }

    try {
      const result = await withEngineSlot(() => engine.evaluate({ state, questions: variant.questions }))
      const probabilities: Record<string, number> = {}
      for (const [qid, ans] of Object.entries(result.answers)) {
        if (ans.type !== 'noul') throw new Error(`jev: answer "${qid}" is ${ans.type}, expected noul`)
        probabilities[qid] = ans.probability
      }
      const score = Math.max(...Object.values(probabilities))
      const answer: CachedVariantAnswer = {
        probabilities,
        score,
        model: result.model,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cost_usd_estimate: result.costUsdEstimate,
      }
      cache.entries[fingerprint] = answer
      newCalls++
      sinceFlush++
      if (sinceFlush >= 50) {
        saveVariantCache(cachePathForVariant(variant.id, cacheDir), cache)
        sinceFlush = 0
      }
      return { pair, answer, error: null, fromCache: false }
    } catch (e) {
      return { pair, answer: null, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), fromCache: false }
    }
  })

  for (const variant of variants) saveVariantCache(cachePathForVariant(variant.id, cacheDir), caches.get(variant.id)!)
  return { results, newCalls }
}

// ── metrics per variant ──────────────────────────────────────────────────────

export interface OperatingPoint {
  targetFpr: number
  threshold: number
  recall: number
  syntheticHardNegativeFpr: number
  realDirectiveLikeFpr: number
}

export interface VariantReport {
  variantId: string
  label: string
  judged: number
  failed: number
  auc: number
  operatingPoints: OperatingPoint[]
  recallByCategoryAtPrimary: Record<string, number>
  primaryTargetFpr: number
}

const TARGET_FPRS = [0.01, 0.05] as const
const PRIMARY_TARGET_FPR = 0.01

function scoresFor(results: EvalResult[], predicate: (s: InjectionSample) => boolean): number[] {
  return results.filter(r => r.answer && predicate(r.pair.sample)).map(r => r.answer!.score)
}

/**
 * Every input this needs — which sample is a positive, a synthetic hard negative, or a real
 * negative (and whether it's the directive-like slice) — lives on `variantResults[i].pair.sample`
 * already, so the only parameter is the slice of results for this one variant.
 */
export function computeVariantReport(variant: InjectionVariantSpec, variantResults: EvalResult[]): VariantReport {
  const isPositive = (s: InjectionSample) => s.label === 'positive'
  const isSyntheticNegative = (s: InjectionSample) => s.source === 'synthetic' && s.label === 'negative'
  const isRealNegative = (s: InjectionSample) => s.source === 'real'
  const isRealDirectiveLike = (s: InjectionSample) => s.source === 'real' && s.category === 'directive_like'

  const positiveScores = scoresFor(variantResults, isPositive)
  const syntheticNegativeScores = scoresFor(variantResults, isSyntheticNegative)
  const realNegativeScores = scoresFor(variantResults, isRealNegative)
  const realDirectiveLikeScores = scoresFor(variantResults, isRealDirectiveLike)

  const aucSamples = [
    ...positiveScores.map(score => ({ score, label: 1 as const })),
    ...syntheticNegativeScores.map(score => ({ score, label: 0 as const })),
    ...realNegativeScores.map(score => ({ score, label: 0 as const })),
  ]

  const operatingPoints: OperatingPoint[] = TARGET_FPRS.map(targetFpr => {
    const threshold = thresholdForFpr(realNegativeScores, targetFpr)
    return {
      targetFpr,
      threshold,
      recall: recallAt(threshold, positiveScores),
      syntheticHardNegativeFpr: fprAt(threshold, syntheticNegativeScores),
      realDirectiveLikeFpr: fprAt(threshold, realDirectiveLikeScores),
    }
  })

  const primary = operatingPoints.find(p => p.targetFpr === PRIMARY_TARGET_FPR)!
  const categorySamples = variantResults
    .filter(r => r.answer && r.pair.sample.label === 'positive' && r.pair.sample.category)
    .map(r => ({ score: r.answer!.score, category: r.pair.sample.category! }))

  const judged = variantResults.filter(r => r.answer !== null).length
  const failed = variantResults.filter(r => r.error !== null).length

  return {
    variantId: variant.id,
    label: variant.label,
    judged,
    failed,
    auc: rocAuc(aucSamples),
    operatingPoints,
    recallByCategoryAtPrimary: recallByCategory(primary.threshold, categorySamples),
    primaryTargetFpr: PRIMARY_TARGET_FPR,
  }
}

/** Real sample ids flagged above 0.9 by ANY variant — the "send this to a human" list. */
export function needsHumanReview(allResults: EvalResult[]): string[] {
  const ids = new Set<string>()
  for (const r of allResults) {
    if (r.answer && r.pair.sample.source === 'real' && r.answer.score > 0.9) ids.add(r.pair.sample.id)
  }
  return [...ids].sort()
}

/** Ranks variants by AUC (desc), then by recall at the primary operating point (desc). */
export function recommendVariant(reports: VariantReport[]): VariantReport | null {
  if (reports.length === 0) return null
  const ranked = [...reports].sort((a, b) => {
    if (Number.isNaN(a.auc) && Number.isNaN(b.auc)) return 0
    if (Number.isNaN(a.auc)) return 1
    if (Number.isNaN(b.auc)) return -1
    if (b.auc !== a.auc) return b.auc - a.auc
    const aPrimary = a.operatingPoints.find(p => p.targetFpr === PRIMARY_TARGET_FPR)?.recall ?? 0
    const bPrimary = b.operatingPoints.find(p => p.targetFpr === PRIMARY_TARGET_FPR)?.recall ?? 0
    return bPrimary - aPrimary
  })
  return ranked[0]
}

// ── report rendering ─────────────────────────────────────────────────────────

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : String(x)
}

function renderVariantReport(r: VariantReport): string {
  const lines: string[] = []
  lines.push(`${r.variantId} — ${r.label}`)
  lines.push(`  judged: ${r.judged}  failed: ${r.failed}  AUC: ${fmt(r.auc)}`)
  for (const op of r.operatingPoints) {
    lines.push(
      `  @ ${(op.targetFpr * 100).toFixed(0)}% FPR (real negatives): threshold=${fmt(op.threshold)}  ` +
        `recall=${fmt(op.recall)}  synthetic-hard-neg FPR=${fmt(op.syntheticHardNegativeFpr)}  ` +
        `real directive-like FPR=${fmt(op.realDirectiveLikeFpr)}`
    )
  }
  lines.push(`  recall by category @ ${(r.primaryTargetFpr * 100).toFixed(0)}% FPR:`)
  for (const [category, recall] of Object.entries(r.recallByCategoryAtPrimary).sort()) {
    lines.push(`    ${category.padEnd(24)} ${fmt(recall)}`)
  }
  return lines.join('\n')
}

function renderStoreCounts(perStore: RealNegativeStoreCounts[]): string {
  return perStore
    .map(s =>
      s.found
        ? `  ${s.path}: ${s.totalEntries} entries, sampled ${s.sampled}, directive-like ${s.directiveLike}`
        : `  ${s.path}: NOT FOUND (skipped)`
    )
    .join('\n')
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const reportOnly = argv.includes('--report-only')
  const cacheDir = process.env[CACHE_DIR_ENV]?.trim() || DEFAULT_CACHE_DIR

  console.error(`cache dir: ${cacheDir}`)
  console.error(`variants: ${INJECTION_VARIANTS.map(v => v.id).join(', ')}`)

  const syntheticPositives = loadSyntheticPositives()
  const syntheticNegatives = loadSyntheticHardNegatives()
  const deepsetPositives = reportOnly
    ? await loadDeepsetPositives({ log: () => {} }).catch(() => [])
    : await loadDeepsetPositives()
  const { samples: realNegatives, perStore } = sampleRealNegatives()

  const positives = [...syntheticPositives, ...deepsetPositives]
  const allSamples = [...positives, ...syntheticNegatives, ...realNegatives]

  console.error(
    `dataset: ${syntheticPositives.length} synthetic positives, ${deepsetPositives.length} deepset positives, ` +
      `${syntheticNegatives.length} synthetic hard negatives, ${realNegatives.length} real negatives (sampled + directive-like)`
  )
  console.error(renderStoreCounts(perStore))

  let results: EvalResult[]
  let newCalls = 0
  if (reportOnly) {
    // Recompute purely from cache: every pair whose fingerprint isn't cached surfaces as a miss
    // (answer: null), which computeVariantReport treats as unjudged rather than a hard failure.
    results = []
    for (const variant of INJECTION_VARIANTS) {
      const cache = loadVariantCache(cachePathForVariant(variant.id, cacheDir), variant.id)
      for (const sample of allSamples) {
        const state = buildVariantState(variant, sample.content)
        const fingerprint = fingerprintVariantState(variant, state)
        const cached = cache.entries[fingerprint]
        results.push({
          pair: { variant, sample },
          answer: cached ?? null,
          error: cached ? null : 'not cached (--report-only)',
          fromCache: Boolean(cached),
        })
      }
    }
  } else {
    const evalOutcome = await evaluateAll(allSamples, INJECTION_VARIANTS, cacheDir)
    results = evalOutcome.results
    newCalls = evalOutcome.newCalls
  }

  const totalCost = results
    .filter(r => !r.fromCache && r.answer !== null)
    .reduce((sum, r) => sum + (r.answer?.cost_usd_estimate ?? 0), 0)

  const reports = INJECTION_VARIANTS.map(variant => {
    const variantResults = results.filter(r => r.pair.variant.id === variant.id)
    return computeVariantReport(variant, variantResults)
  })

  const recommended = recommendVariant(reports)
  const reviewIds = needsHumanReview(results)

  console.log('Prompt-injection eval — variant comparison')
  console.log('')
  console.log(
    `dataset: ${positives.length} positives (${syntheticPositives.length} synthetic + ${deepsetPositives.length} deepset), ` +
      `${syntheticNegatives.length} synthetic hard negatives, ${realNegatives.length} real negatives`
  )
  console.log(`jev: ${newCalls} new call(s), ${results.filter(r => r.fromCache).length} served from cache`)
  console.log(`jev cost (new calls only, at configured pricing): $${totalCost.toFixed(4)}`)
  console.log('')
  for (const r of reports) {
    console.log(renderVariantReport(r))
    console.log('')
  }
  if (recommended) {
    const primary = recommended.operatingPoints.find(p => p.targetFpr === PRIMARY_TARGET_FPR)!
    console.log(
      `recommended: ${recommended.variantId} (AUC ${fmt(recommended.auc)}) — ` +
        `operate at threshold ${fmt(primary.threshold)} (${(primary.targetFpr * 100).toFixed(0)}% FPR on real negatives), ` +
        `recall ${fmt(primary.recall)}`
    )
  } else {
    console.log('recommended: none (no variant produced usable results)')
  }
  console.log('')
  console.log(`needs-human-review (real entries scored > 0.9 by any variant): ${reviewIds.length}`)
  if (reviewIds.length > 0) console.log(`  ids: ${JSON.stringify(reviewIds)}`)
}

// Only run when executed directly (`tsx src/scripts/eval-injection.ts`), not when imported by a
// test for its pure helpers.
if (process.argv[1] && process.argv[1].endsWith('eval-injection.ts')) {
  main().catch(e => {
    console.error('fatal:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
