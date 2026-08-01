/**
 * Ranker variants, isolated so competing scorers can be replayed over an identical
 * candidate pool.
 *
 * Background: on 2026-08-01 three baseline runs measured retrieval getting WORSE after
 * two ranking changes shipped (mean P@5 0.54 -> 0.43). The regression could not be
 * attributed, because the ranker and the corpus changed on the same day AND every
 * measurement only ever saw the shipped ranker's own top-N. Comparing two rankers on a
 * set that one of them selected is not a comparison.
 *
 * A ranker here is a pure function (candidates, query) -> ordered candidates. Given a
 * frozen pool captured by KMS_EVAL_CAPTURE, any two can be scored against the same
 * relevance labels.
 */

export interface EvalCandidate {
  id: string
  content: string
  confidence?: number
  timestamp?: string
  contentType?: string
  sourceSystem?: string
  subject?: string | null
  extractedBy?: string | null
  [k: string]: unknown
}

export type Ranker = (candidates: EvalCandidate[], query: string) => EvalCandidate[]

// ── legacy (pre-#85) ─────────────────────────────────────────────────────────
// Reproduced from git 61e0fe06^ INCLUDING its defects, because an honest baseline
// must be the thing that actually ran: substring matching, and the exact-phrase bonus
// applied inside the per-term loop so an N-term match scored it N times.

function legacyRelevance(content: string, query: string): number {
  if (!content || !query) return 0
  const cl = content.toLowerCase()
  const ql = query.toLowerCase()
  const terms = ql.split(/\s+/).filter(Boolean)
  if (!terms.length) return 0
  let score = 0
  for (const t of terms) {
    if (cl.includes(t)) {
      score += 1
      if (cl.includes(ql)) score += 0.5
    }
  }
  return score / terms.length
}

export const legacyRanker: Ranker = (candidates, query) =>
  [...candidates].sort((a, b) => {
    const cd = (b.confidence ?? 0) - (a.confidence ?? 0)
    if (Math.abs(cd) > 0.1) return cd
    return legacyRelevance(b.content, query) - legacyRelevance(a.content, query)
  })

// ── score-order (whatever the service produced) ──────────────────────────────
// The pool is captured already ranked, so this replays the shipped ranker without
// reimplementing it — no risk of the copy drifting from production.

export const shippedRanker: Ranker = candidates =>
  [...candidates].sort((a, b) => ((b._score as number) ?? 0) - ((a._score as number) ?? 0))

// ── metrics ──────────────────────────────────────────────────────────────────

/** Relevance labels for one query: id -> 1 (relevant) | 0 (marginal/irrelevant). */
export type Labels = Record<string, number>

/**
 * This is a measurement harness — a metric that silently returns NaN/Infinity on a bad
 * `k` is worse than one that throws, because a bad number gets trusted and reported as
 * if it meant something. Reject negative and non-integer k consistently rather than
 * letting `slice`/division absorb it silently.
 */
function validateK(k: number): void {
  if (!Number.isInteger(k) || k < 0) {
    throw new RangeError(`k must be a non-negative integer, got ${k}`)
  }
}

export function precisionAtK(ordered: EvalCandidate[], labels: Labels, k: number): number {
  validateK(k)
  const top = ordered.slice(0, k)
  if (!top.length) return 0
  return top.filter(c => labels[c.id] === 1).length / k
}

export function reciprocalRank(ordered: EvalCandidate[], labels: Labels): number {
  const i = ordered.findIndex(c => labels[c.id] === 1)
  return i === -1 ? 0 : 1 / (i + 1)
}

/**
 * nDCG@k with binary gains. Included because P@5 alone cannot distinguish "the one
 * relevant hit is at rank 1" from "it is at rank 5" — a distinction that matters when
 * comparing orderings over an identical pool, which is exactly this harness's job.
 */
export function ndcgAtK(ordered: EvalCandidate[], labels: Labels, k: number): number {
  validateK(k)
  const dcg = ordered.slice(0, k).reduce(
    (acc, c, i) => acc + (labels[c.id] === 1 ? 1 / Math.log2(i + 2) : 0), 0)
  const nRelevant = Object.values(labels).filter(v => v === 1).length
  const ideal = Array.from({ length: Math.min(k, nRelevant) })
    .reduce<number>((acc, _, i) => acc + 1 / Math.log2(i + 2), 0)
  return ideal === 0 ? 0 : dcg / ideal
}

/** Share of the top-k that is meta/self-referential rather than domain knowledge. */
export function metaShareAtK(ordered: EvalCandidate[], k: number): number {
  validateK(k)
  const top = ordered.slice(0, k)
  if (!top.length) return 0
  const isMeta = (c: EvalCandidate) =>
    c.extractedBy === 'kms-session-extract' ||
    /^(KMS\.|KMSmcp\.|SparrowDB\.bugs|MacMini\.config|orchestration\.)/.test(c.subject ?? '')
  return top.filter(isMeta).length / k
}
