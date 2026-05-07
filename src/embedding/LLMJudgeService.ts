/**
 * LLMJudgeService — Tier 2 dedup-gate classifier (DG-T2-A, issue #49).
 *
 * For candidates that fall in the borderline confirm-band (between
 * `confirmThreshold` and `refuseThreshold`), Tier 1 cosine similarity alone
 * isn't enough to characterize the relationship. We hand the (new_content,
 * candidate_content) pair to a small/cheap LLM and ask it to classify the
 * relationship into one of six relations:
 *
 *   - duplicate          : same fact, no new information
 *   - supersedes         : new content corrects/replaces the candidate
 *   - supersedes-reverse : candidate corrects/replaces the new content (rare)
 *   - complement         : both true, different facets — keep both
 *   - contradicts        : factually opposed; humans must decide
 *   - unrelated          : different facts that happened to embed near each other
 *
 * Architectural notes:
 *   - Mirrors the EmbeddingService shape: dependency-injected, liveness probe,
 *     graceful degradation. Every code path that uses this service must
 *     handle `null` (judge unavailable / not configured).
 *   - LRU-cached: keyed on SHA-256 of `newContent|candidateContent` so identical
 *     pairs in a single session don't re-call the model. Max 1000 entries.
 *   - Hard 5-second per-call timeout via AbortController. On timeout we return
 *     `unrelated` from `classify()` only if the implementation chooses; the
 *     UnifiedStoreTool integration treats any thrown error as "leave the
 *     candidate's `llm_relation: null`" so the gate response still ships.
 *   - Cost-conscious: callers MUST skip this for refuse-band candidates
 *     (those are already definitively "duplicate" structurally).
 */

import crypto from 'crypto'
import { logger } from '../logger.js'

export type LLMRelation =
  | 'duplicate'
  | 'supersedes'
  | 'supersedes-reverse'
  | 'complement'
  | 'contradicts'
  | 'unrelated'

const ALL_RELATIONS: readonly LLMRelation[] = [
  'duplicate',
  'supersedes',
  'supersedes-reverse',
  'complement',
  'contradicts',
  'unrelated'
] as const

/**
 * The Tier 2 LLM judge. Implementations should be deterministic at the prompt
 * level (same pair → same answer) but the cache makes that less load-bearing.
 */
export interface LLMJudgeService {
  /** Stable model identifier for audit logs. e.g. 'claude-haiku-4-5-20251001'. */
  readonly modelId: string

  /**
   * Classify the relationship between two pieces of content. Throws on
   * transport/model failure — the caller (UnifiedStoreTool) catches and
   * leaves `llm_relation: null` for that candidate.
   */
  classify(args: {
    newContent: string
    candidateContent: string
  }): Promise<LLMRelation>

  /**
   * Quick liveness probe. Used by callers to short-circuit when the judge is
   * unconfigured/unreachable so we don't burn the 5 s timeout on every
   * candidate. Cached internally (~30 s) so callers can poll cheaply.
   */
  isAvailable(): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Shared helpers (parsing + cache) — exported for testing the concrete impl.
// ---------------------------------------------------------------------------

/**
 * Parse a free-form LLM response into an LLMRelation, leniently.
 * Strategy:
 *   1. Lowercase + trim
 *   2. Look for an exact match against any of the 6 relation strings as a
 *      whole word (regex with word boundaries — `supersedes-reverse` first
 *      so it doesn't get short-circuited by `supersedes`)
 *   3. Fallback: 'unrelated' (safest — won't trigger any UI urgency)
 *
 * Exported so the concrete implementation and its tests share the same
 * parser definition.
 */
export function parseLLMRelation(raw: string): LLMRelation {
  if (typeof raw !== 'string' || raw.length === 0) return 'unrelated'
  const normalized = raw.trim().toLowerCase()

  // Order matters: longer/more-specific tokens first so 'supersedes-reverse'
  // wins over 'supersedes' when both substrings appear.
  const orderedProbes: LLMRelation[] = [
    'supersedes-reverse',
    'supersedes',
    'duplicate',
    'complement',
    'contradicts',
    'unrelated'
  ]

  for (const probe of orderedProbes) {
    // \b doesn't match across the dash in JS regex by default — the dash is
    // a word boundary itself — so anchor with explicit start/non-word lookarounds.
    const re = new RegExp(`(^|[^a-z0-9-])${probe}([^a-z0-9-]|$)`)
    if (re.test(normalized)) return probe
  }

  return 'unrelated'
}

/**
 * Build the deterministic cache key for a (newContent, candidateContent) pair.
 * SHA-256 + ascii separator so collisions across content boundaries are
 * vanishingly unlikely.
 */
export function judgeCacheKey(newContent: string, candidateContent: string): string {
  return crypto
    .createHash('sha256')
    .update(newContent)
    .update('|')
    .update(candidateContent)
    .digest('hex')
}

/**
 * Tiny LRU map. We don't pull in `lru-cache` because it's not already a
 * dependency and the behavior we need (insertion-order eviction with
 * read-bump) is ~30 lines.
 */
export class LRUCache<K, V> {
  private map = new Map<K, V>()
  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) throw new Error('LRUCache: maxSize must be > 0')
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    // Bump to most-recent by re-inserting.
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    // If key already present, delete first so the re-insert puts it at the
    // end (most-recent) regardless of its prior position.
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.maxSize) {
      // Map iteration is insertion-order — first key is least-recently used.
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }
}

export const LLM_RELATIONS = ALL_RELATIONS

/**
 * Re-export the logger reference so callers using `LLMJudgeService` don't have
 * to import it separately when they want to log around a classify() call.
 * Prevents accidental console.log usage in MCP stdio mode.
 */
export { logger as judgeLogger }
