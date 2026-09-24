/**
 * Jev-label-vs-Gemma agreement — how far can Jev's labels (`../eval/jevLabel.ts`) be
 * trusted against the existing Gemma-graded calibration set, before using Jev as the
 * LABELLER for the full ~554-query pool (`label-recall-pool.ts --labeler jev`)?
 *
 * Two Gemma-graded sources, combined:
 *   - the 60-query prototype pool (`PROTOTYPE_POOL_PATH`, imported from `label-recall-pool.ts`)
 *   - every `label_source: "gemma"` row already in the live pool (`POOL_PATH`) — the
 *     29-query run from PR #138
 *
 * For every (query, candidate) pair from either source with a non-null Gemma grade, this
 * asks Jev the SAME question `label-recall-pool.ts --labeler jev` would (one Choice call,
 * cached in the SAME `cache/jev-labels.jsonl` the main pipeline uses — a pair labelled here
 * is never re-asked of Jev later), then reports exact/kappa/binary agreement between the
 * two, overall and sliced by source/kind (`../eval/agreement.ts`).
 *
 * Usage:
 *   doppler run --project ry-local --config dev_eng -- npx tsx src/scripts/jev-label-agreement.ts
 *
 * Bounded to `JEV_LABEL_CONCURRENCY` (40) in-flight requests, same as the main pipeline's
 * Jev-labeller pass — the shared 15 rps / 100-deep-queue rate limiter (`../decision/engineSlot.ts`).
 */
import fs from 'fs'
import { createJevDecisionEngineFromEnv } from '../decision/JevDecisionEngine.js'
import type { DecisionEngine } from '../decision/types.js'
import {
  buildAgreementReport,
  renderAgreementReport,
  type AgreementPair,
  type QueryKind,
  type Source,
} from '../eval/agreement.js'
import { appendJevLabelCacheEntry, judgeJevLabel, loadJevLabelCache, type JevLabelCacheEntry } from '../eval/jevLabel.js'
import {
  JEV_LABEL_CACHE_PATH,
  JEV_LABEL_CONCURRENCY,
  POOL_PATH,
  PROTOTYPE_POOL_PATH,
  classifyQueryKind,
  labelCacheKey,
  loadPoolRows,
  type PoolRow,
} from './label-recall-pool.js'

// ── item collection (pure) ───────────────────────────────────────────────────

export interface AgreementItem {
  query: string
  id: string
  content: string
  gemmaGrade: 0 | 1 | 2
  source: Source
  kind: QueryKind
}

function isGrade(g: unknown): g is 0 | 1 | 2 {
  return g === 0 || g === 1 || g === 2
}

/** The 60-query prototype pool — no `source`/`kind` fields on disk (it predates that
 *  tagging), so `source` is the pseudo-bucket `'prototype'` and `kind` is computed the same
 *  way the main pipeline classifies a live query. */
export function collectPrototypeItems(poolText: string): AgreementItem[] {
  const out: AgreementItem[] = []
  for (const raw of poolText.split('\n')) {
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
    const kind = classifyQueryKind(r.query)
    for (const c of r.candidates as unknown[]) {
      const cand = c as { id?: unknown; content?: unknown; grade?: unknown }
      if (typeof cand.id !== 'string' || typeof cand.content !== 'string' || !isGrade(cand.grade)) continue
      out.push({ query: r.query, id: cand.id, content: cand.content, gemmaGrade: cand.grade, source: 'prototype', kind })
    }
  }
  return out
}

/** Only rows the pipeline actually Gemma-graded (`label_source: "gemma"`, or the field
 *  absent — `loadPoolRows` already defaults missing rows to `'gemma'`). A row the pipeline
 *  later Jev-labelled (`label_source: "jev"`) is excluded: agreement is measured against
 *  Gemma's OWN grades, never against Jev grading itself. */
export function collectPoolItems(rows: readonly PoolRow[]): AgreementItem[] {
  const out: AgreementItem[] = []
  for (const row of rows) {
    if (row.label_source !== 'gemma') continue
    for (const c of row.candidates) {
      if (!isGrade(c.grade)) continue
      out.push({ query: row.query, id: c.id, content: c.content, gemmaGrade: c.grade, source: row.source, kind: row.kind })
    }
  }
  return out
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

// ── labelling (network) ──────────────────────────────────────────────────────

export interface LabelRunStats {
  newCalls: number
  cacheHits: number
  failed: number
  costUsd: number
}

export async function labelItems(
  items: readonly AgreementItem[],
  engine: DecisionEngine,
  cache: Map<string, JevLabelCacheEntry>,
  cachePath: string
): Promise<{ pairs: AgreementPair[]; stats: LabelRunStats }> {
  const stats: LabelRunStats = { newCalls: 0, cacheHits: 0, failed: 0, costUsd: 0 }
  const keyed = items.map(item => ({ item, key: labelCacheKey(item.query, item.id, item.content) }))

  await mapBounded(
    keyed.filter(k => !cache.has(k.key)),
    JEV_LABEL_CONCURRENCY,
    async ({ item, key }) => {
      try {
        const label = await judgeJevLabel(engine, item.query, item.content)
        cache.set(key, label)
        appendJevLabelCacheEntry(cachePath, key, label)
        stats.newCalls++
        stats.costUsd += label.costUsdEstimate ?? 0
      } catch (e) {
        stats.failed++
        console.error(`jev label failed for candidate ${item.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  const pairs: AgreementPair[] = []
  for (const { item, key } of keyed) {
    const cached = cache.get(key)
    if (!cached) continue // failed call (or a failed prior run) — no grade to compare
    pairs.push({ gemmaGrade: item.gemmaGrade, jevGrade: cached.grade as 0 | 1 | 2, source: item.source, kind: item.kind })
  }
  stats.cacheHits = pairs.length - stats.newCalls
  return { pairs, stats }
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const prototypeText = fs.existsSync(PROTOTYPE_POOL_PATH) ? fs.readFileSync(PROTOTYPE_POOL_PATH, 'utf8') : ''
  if (!prototypeText) console.error(`warn: ${PROTOTYPE_POOL_PATH} not found or empty — prototype pool contributes 0 pairs`)
  const prototypeItems = collectPrototypeItems(prototypeText)

  const poolRows = loadPoolRows(POOL_PATH)
  const poolItems = collectPoolItems(poolRows)

  const items = [...prototypeItems, ...poolItems]
  console.error(
    `items: ${prototypeItems.length} from the prototype pool, ${poolItems.length} from the live pool (gemma-labelled rows only), ${items.length} total`
  )

  const engine = createJevDecisionEngineFromEnv()
  if (!engine) {
    throw new Error('no Jev credential route (OneCLI gateway or TYPESAFE_API_KEY) — cannot label anything')
  }

  const cache = loadJevLabelCache(JEV_LABEL_CACHE_PATH)
  const started = Date.now()
  const { pairs, stats } = await labelItems(items, engine, cache, JEV_LABEL_CACHE_PATH)
  const wallMs = Date.now() - started

  console.error(
    `jev: ${stats.newCalls} new call(s), ${stats.cacheHits} served from cache, ${stats.failed} failed, ` +
      `cost $${stats.costUsd.toFixed(4)}` +
      (stats.newCalls > 0 ? ` (mean $${(stats.costUsd / stats.newCalls).toFixed(6)}/call)` : '') +
      `, wall ${(wallMs / 1000).toFixed(1)}s`
  )
  if (stats.failed > 0) {
    console.error(`warn: ${stats.failed}/${items.length} pairs have no Jev label and are excluded from agreement`)
  }

  const report = buildAgreementReport(pairs)
  console.log(renderAgreementReport(report))
}

// Only run when executed directly, not when imported by a test for its pure helpers.
if (process.argv[1] && process.argv[1].endsWith('jev-label-agreement.ts')) {
  main().catch(e => {
    console.error('fatal:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
