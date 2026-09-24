/**
 * Recall beyond the current re-rank window — for each query, where (in PRODUCTION order)
 * does the first grade-2 candidate sit, relative to `KMS_JEV_SHADOW_TOPK`'s default (the
 * window the served v2 re-rank actually judges, `JEV_SHADOW_TOPK_DEFAULT` in
 * `../decision/shadowRerank.ts`)? Only measurable with Jev as the labeller (Gemma's ~170 s
 * per query made a top-50 pool impractical) and only meaningful on rows fetched deep enough
 * to see rank 21-50 at all.
 */
import { JEV_SHADOW_TOPK_DEFAULT } from '../decision/shadowRerank.js'

export type Source = 'eng' | 'personal'
export type QueryKind = 'human' | 'agent-payload'

export interface RecallWindowCandidate {
  id: string
  prod_rank: number
  grade: number | null
}

export interface RecallWindowQuery {
  source: Source
  kind: QueryKind
  candidates: readonly RecallWindowCandidate[]
}

export type RecallWindowBucket = 'in_window' | 'beyond_window' | 'none_in_top'

export interface RecallWindowResult {
  /** Production-order rank (1-based) of the first grade-2 candidate, or null if none was
   *  found within the fetched candidates. */
  firstGrade2Rank: number | null
  bucket: RecallWindowBucket
  /** How many candidates this query actually had to look through (may be < `maxRank` if
   *  the server returned fewer than requested). */
  candidatesSeen: number
}

/**
 * `windowSize` is the current re-rank window (`KMS_JEV_SHADOW_TOPK`, default
 * `JEV_SHADOW_TOPK_DEFAULT` = 20); `maxRank` is how deep this query's candidates were
 * fetched (the `--topk` the pool was built with, capped to what was actually returned).
 */
export function classifyRecallWindow(query: RecallWindowQuery, windowSize: number, maxRank: number): RecallWindowResult {
  const sorted = [...query.candidates].sort((a, b) => a.prod_rank - b.prod_rank).filter(c => c.prod_rank <= maxRank)
  const firstGrade2 = sorted.find(c => c.grade === 2)
  const firstGrade2Rank = firstGrade2 ? firstGrade2.prod_rank : null
  const bucket: RecallWindowBucket =
    firstGrade2Rank === null ? 'none_in_top' : firstGrade2Rank <= windowSize ? 'in_window' : 'beyond_window'
  return { firstGrade2Rank, bucket, candidatesSeen: sorted.length }
}

export interface RecallWindowSummary {
  slice: string
  /** Queries actually classified — only rows with at least `maxRank` candidates seen
   *  count, so a partial-window row never inflates "none_in_top" by omission. */
  n: number
  /** Queries excluded from `n` because fewer than `maxRank` candidates were fetched. */
  excludedShallow: number
  shareInWindow: number
  shareBeyondWindow: number
  shareNoneInTop: number
}

export function summarizeRecallWindow(
  name: string,
  queries: readonly RecallWindowQuery[],
  windowSize: number = JEV_SHADOW_TOPK_DEFAULT,
  maxRank = 50
): RecallWindowSummary {
  let excludedShallow = 0
  const results: RecallWindowResult[] = []
  for (const q of queries) {
    const maxProdRank = q.candidates.reduce((m, c) => Math.max(m, c.prod_rank), 0)
    if (maxProdRank < maxRank) {
      excludedShallow++
      continue
    }
    results.push(classifyRecallWindow(q, windowSize, maxRank))
  }
  const n = results.length
  const count = (b: RecallWindowBucket): number => results.filter(r => r.bucket === b).length
  return {
    slice: name,
    n,
    excludedShallow,
    shareInWindow: n === 0 ? 0 : count('in_window') / n,
    shareBeyondWindow: n === 0 ? 0 : count('beyond_window') / n,
    shareNoneInTop: n === 0 ? 0 : count('none_in_top') / n,
  }
}

const SOURCES: readonly Source[] = ['eng', 'personal']
const KINDS: readonly QueryKind[] = ['human', 'agent-payload']

export function sliceRecallWindowQueries(queries: readonly RecallWindowQuery[]): Record<string, RecallWindowQuery[]> {
  const out: Record<string, RecallWindowQuery[]> = { overall: [...queries] }
  for (const source of SOURCES) out[`source:${source}`] = queries.filter(q => q.source === source)
  for (const kind of KINDS) out[`kind:${kind}`] = queries.filter(q => q.kind === kind)
  return out
}

export function buildRecallWindowReport(
  queries: readonly RecallWindowQuery[],
  windowSize: number = JEV_SHADOW_TOPK_DEFAULT,
  maxRank = 50
): RecallWindowSummary[] {
  const slices = sliceRecallWindowQueries(queries)
  return Object.entries(slices).map(([name, sliceQueries]) => summarizeRecallWindow(name, sliceQueries, windowSize, maxRank))
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

export function renderRecallWindowReport(summaries: readonly RecallWindowSummary[], windowSize: number, maxRank: number): string {
  const lines: string[] = []
  lines.push(`Recall beyond the re-rank window (Jev labels, top-${maxRank}; window = top-${windowSize})`)
  lines.push('')
  for (const s of summaries) {
    lines.push(`[${s.slice}]  n=${s.n}${s.excludedShallow ? `  (${s.excludedShallow} excluded: fewer than ${maxRank} candidates fetched)` : ''}`)
    if (s.n === 0) {
      lines.push('  (no queries with a full window in this slice)')
      continue
    }
    lines.push(`  first grade-2 in rank 1-${windowSize} (in window)       ${pct(s.shareInWindow)}`)
    lines.push(`  first grade-2 in rank ${windowSize + 1}-${maxRank} (beyond window)  ${pct(s.shareBeyondWindow)}`)
    lines.push(`  no grade-2 candidate in top ${maxRank} at all           ${pct(s.shareNoneInTop)}`)
    lines.push('')
  }
  return lines.join('\n')
}
