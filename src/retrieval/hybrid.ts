/**
 * Hybrid retrieval — Reciprocal Rank Fusion over a lexical arm and a vector arm.
 *
 * Why this module exists
 * ----------------------
 * `UnifiedSearchTool.search()` fanned out to three backends (mem0 / graph / mongodb)
 * that are all *lexical*: they match query terms against stored text. Meanwhile the
 * store carries a populated HNSW vector index that only the write-side dedup gate ever
 * touched. Adding a vector arm to the read path recovers that recall.
 *
 * Recall alone is not enough, and this is the crux. A semantically-retrieved candidate
 * with zero term overlap scores ~0 on `calculateRelevance`, so the existing composite
 * (`relevance*0.70 + recency*0.25 + confidence*0.05`) buries it beneath every incidental
 * keyword hit. Merging the arms without changing the ordering would add candidates that
 * can never surface.
 *
 * Why RRF rather than blending the scores
 * ---------------------------------------
 * The two arms emit incomparable quantities: the lexical composite is a bounded
 * hand-weighted mixture in [0, 1]; the vector arm emits cosine similarity, whose useful
 * dynamic range on this corpus sits in a narrow band near the top (the dedup gate's own
 * calibration puts "duplicate" at >= 0.88 and "distinct" below 0.78 — a 0.10-wide
 * decision band). Any weighted sum of the two needs a normalisation constant that is
 * really a hidden hyper-parameter, and it has to be re-derived whenever either arm
 * changes. RRF discards the magnitudes and fuses *ranks*, so it needs no normalisation
 * and cannot be destabilised by one arm's scores drifting.
 *
 *     score(d) = Σ_i  w_i / (k + rank_i(d))
 *
 * `k = 60` is the constant from the original RRF paper (Cormack, Clarke & Buettcher,
 * SIGIR 2009) and the de facto default in every hybrid-search implementation since. It
 * is deliberately NOT tuned here: k damps the contribution of top ranks so that a single
 * arm cannot dominate on its #1 alone, and picking a bespoke value on reasoning rather
 * than measurement is exactly the mistake this whole change is gated against.
 *
 * Weights are 1.0 / 1.0 — equal. Two reasons. First, unequal weights are a tuned
 * parameter and nothing here has been measured yet. Second, only ~29% of the corpus is
 * embedded today (806 of 2761 entries in the live store carry an embedder id, counted
 * 2026-08-01), so the vector arm's *coverage* is the binding constraint, not its weight;
 * up-weighting a mostly-absent arm would measure the backfill's progress rather than the
 * fusion's value. Revisit after the harness reports.
 *
 * Recency is a strict tie-break, never a term
 * -------------------------------------------
 * The lexical composite gives recency 0.25 of the total, and a measured consequence is
 * that recency *raises* the meta-noise share of the top-k: freshly written
 * session-extract entries are both recent and keyword-dense, so they park at the top of
 * queries they have nothing to do with. Folding recency into the fused score would carry
 * that defect straight through the fusion. Here it only ever breaks an exact RRF tie —
 * which is common, because a candidate ranked #1 by one arm alone and a candidate ranked
 * #1 by the other arm alone score identically (1/(k+1)).
 *
 * Everything in this module is a pure function so the fusion can be replayed offline
 * over a frozen candidate pool (see `src/eval/rankers.ts` and `KMS_EVAL_CAPTURE`).
 */

/** Environment flag that turns hybrid retrieval on. Default OFF. */
export const HYBRID_RETRIEVAL_FLAG = 'KMS_HYBRID_RETRIEVAL'

/**
 * RRF damping constant. 60 is the published default (Cormack et al. 2009). Exported so
 * the eval harness fuses with the identical constant the service used.
 */
export const RRF_K = 60

/** Per-arm RRF weights. Equal by design — see the module header. */
export const RRF_WEIGHT_LEXICAL = 1
export const RRF_WEIGHT_VECTOR = 1

/**
 * Backends whose hits count as "retrieved by the lexical arm". The vector arm tags its
 * hits `vector`, so membership of each ranked list is decided by provenance rather than
 * by whether a score happens to be non-zero.
 */
export const LEXICAL_SOURCE_SYSTEMS: ReadonlySet<string> = new Set(['mem0', 'graph', 'mongodb'])

/** Sentinel `sourceSystem` for candidates produced by the vector arm. */
export const VECTOR_SOURCE_SYSTEM = 'vector'

/**
 * Is hybrid retrieval enabled?
 *
 * Strictly `'1'`. Not "any truthy string" — an operator who exports
 * `KMS_HYBRID_RETRIEVAL=0` to turn the feature *off* must not accidentally turn it on.
 */
export function isHybridRetrievalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HYBRID_RETRIEVAL_FLAG] === '1'
}

/** The fields fusion reads off a deduplicated candidate. */
export interface FusionCandidate {
  id?: string
  /** Set when the candidate came from exactly one backend. */
  sourceSystem?: string
  /** Set by `deduplicateResults` when the same item arrived from several backends. */
  _sourceSystems?: string[]
  /** The pre-existing lexical composite (relevance/recency/confidence), if lexical. */
  _lexicalScore?: number
  /** Recency weight in [0, 1] — tie-break only. */
  _recency?: number
  /** Cosine similarity from the vector arm, if the vector arm retrieved this. */
  _vectorSimilarity?: number
  [k: string]: unknown
}

/** A candidate after fusion — the signals are attached, not hidden. */
export interface FusedCandidate extends FusionCandidate {
  /** 1-based position within the lexical arm's ranked list. Absent if not retrieved by it. */
  _lexicalRank?: number
  /** 1-based position within the vector arm's ranked list. Absent if not retrieved by it. */
  _vectorRank?: number
  /** Σ w_i / (k + rank_i). */
  _rrf: number
}

/** Every backend this candidate was seen in. */
export function candidateSourceSystems(c: FusionCandidate): string[] {
  if (Array.isArray(c._sourceSystems) && c._sourceSystems.length > 0) {
    return c._sourceSystems.filter((s): s is string => typeof s === 'string')
  }
  return typeof c.sourceSystem === 'string' ? [c.sourceSystem] : []
}

/**
 * Did the lexical arm retrieve this candidate?
 *
 * Provenance, not score. A lexical hit whose relevance rounds to 0 (a stopword-only
 * overlap, say) is still a member of the lexical result list and gets a rank; a
 * vector-only hit is not a member no matter what its lexical score computes to. That
 * distinction is what makes this RRF rather than a disguised score blend.
 */
export function isLexicalCandidate(c: FusionCandidate): boolean {
  return candidateSourceSystems(c).some(s => LEXICAL_SOURCE_SYSTEMS.has(s))
}

/** Did the vector arm retrieve this candidate? */
export function isVectorCandidate(c: FusionCandidate): boolean {
  return typeof c._vectorSimilarity === 'number' && Number.isFinite(c._vectorSimilarity)
}

/**
 * Assign 1-based ranks over `members`, ordered by `score` descending.
 *
 * `Array.prototype.sort` is stable (ES2019), so equal scores keep their incoming order —
 * which is the fixed backend fan-out order, hence deterministic across runs.
 */
function rankBy<T extends FusionCandidate>(
  members: T[],
  score: (c: T) => number
): Map<T, number> {
  const ordered = [...members].sort((a, b) => score(b) - score(a))
  const ranks = new Map<T, number>()
  ordered.forEach((c, i) => ranks.set(c, i + 1))
  return ranks
}

export interface FuseOptions {
  k?: number
  lexicalWeight?: number
  vectorWeight?: number
}

/**
 * Fuse the lexical and vector arms with Reciprocal Rank Fusion.
 *
 * Input is the *deduplicated* pool: an item found by both arms is one candidate that
 * appears in both ranked lists and therefore accrues both terms — which is precisely the
 * agreement bonus RRF is meant to give.
 *
 * Returns new objects (the inputs are not mutated) ordered by `_rrf` descending, with
 * recency, then lexical score, then id as strictly subordinate tie-breaks.
 */
export function fuseWithRRF<T extends FusionCandidate>(
  candidates: T[],
  options: FuseOptions = {}
): Array<T & FusedCandidate> {
  const k = options.k ?? RRF_K
  const wLex = options.lexicalWeight ?? RRF_WEIGHT_LEXICAL
  const wVec = options.vectorWeight ?? RRF_WEIGHT_VECTOR

  const lexicalRanks = rankBy(
    candidates.filter(isLexicalCandidate),
    c => (typeof c._lexicalScore === 'number' ? c._lexicalScore : 0)
  )
  const vectorRanks = rankBy(
    candidates.filter(isVectorCandidate),
    c => (typeof c._vectorSimilarity === 'number' ? c._vectorSimilarity : 0)
  )

  const fused = candidates.map(c => {
    const lexicalRank = lexicalRanks.get(c)
    const vectorRank = vectorRanks.get(c)
    const rrf =
      (lexicalRank !== undefined ? wLex / (k + lexicalRank) : 0) +
      (vectorRank !== undefined ? wVec / (k + vectorRank) : 0)

    return {
      ...c,
      ...(lexicalRank !== undefined ? { _lexicalRank: lexicalRank } : {}),
      ...(vectorRank !== undefined ? { _vectorRank: vectorRank } : {}),
      // 6 dp: adjacent RRF values differ by ~2.7e-4 at the head of the list and stay
      // above 1e-6 for any pool this system will ever hold, so rounding here cannot
      // manufacture ties that the raw values did not have.
      _rrf: Number(rrf.toFixed(6)),
    } as T & FusedCandidate
  })

  return fused.sort((a, b) => {
    if (b._rrf !== a._rrf) return b._rrf - a._rrf
    // --- strictly subordinate tie-breaks below; none of these can outrank RRF ---
    const recencyDelta = (b._recency ?? 0) - (a._recency ?? 0)
    if (recencyDelta !== 0) return recencyDelta
    const lexDelta = (b._lexicalScore ?? 0) - (a._lexicalScore ?? 0)
    if (lexDelta !== 0) return lexDelta
    // Final determinism guard so two otherwise-identical candidates never swap order
    // between runs (which would make an offline replay disagree with the live run).
    // Plain codepoint comparison, not `localeCompare` — locale-dependent ordering would
    // make this non-deterministic across environments/ICU versions, which is exactly
    // what this guard exists to prevent.
    const idA = String(a.id ?? '')
    const idB = String(b.id ?? '')
    return idA < idB ? -1 : idA > idB ? 1 : 0
  })
}
