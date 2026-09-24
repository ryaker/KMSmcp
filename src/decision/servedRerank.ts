/**
 * Served recall re-rank — step 3 of the KMS × Jev v2 build order
 * (`~/Documents/Notes/kms-jev-architecture-v2.md` §3A / §5).
 *
 * Same judgments `shadowRerank.ts` already asks (one request per candidate, the
 * `recall-evidence/v2` questions, one whole-search deadline, one shared rate limiter —
 * see `evaluateRecallCandidates`), but AWAITED and RETURNED to the `unified_search`
 * caller instead of only logged. Behind `KMS_JEV_RERANK`, default OFF; the owner flips it.
 *
 * The one new thing this file owns: collapsing a Mem0 shard and its graph/Mongo parent
 * into one candidate before judging (§3A: "production top-K … deduped by parent id").
 * `deduplicateResults` in `UnifiedSearchTool` merges same-id duplicates across backends,
 * but a Mem0 shard has ITS OWN id and only carries the parent's id in
 * `metadata.kms_id`/`kmsId` — so today it survives as a second candidate for the same
 * fact. Judging both would pay twice for one judgment and let the shard's score (on a
 * truncated LLM-extracted sentence) outrank its own parent.
 *
 * Safety invariant this whole module exists to guarantee: whatever the engine does, a
 * search using this path is never slower than production + the deadline, and never
 * fails because of it. Every exit that isn't a clean, on-time reorder falls back to the
 * unmodified production order.
 */

import crypto from 'crypto'
import { logger } from '../logger.js'
import { mem0ParentId } from '../storage/Mem0Storage.js'
import type { CandidateDecisionRecord, DecisionLogSink, ShadowRunRecord } from './decisionLog.js'
import {
  JEV_SHADOW_TOPK_DEFAULT,
  evaluateRecallCandidates,
  jevRerankDeadlineMs,
  type RankedRecallCandidate,
} from './shadowRerank.js'
import { RECALL_EVIDENCE_V2_SCHEMA_VERSION } from './recallEvidence.js'
import { SHADOW_POLICY_V2_VERSION, shadowOrder } from './shadowPolicy.js'
import type { DecisionEngine } from './types.js'

/** Serves the Jev order instead of only shadowing it. Default OFF. Strictly `'1'`. */
export const JEV_SERVED_RERANK_FLAG = 'KMS_JEV_RERANK'

export function isJevServedRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_SERVED_RERANK_FLAG] === '1'
}

export type RerankFallbackReason = 'deadline' | 'error' | 'disabled' | 'no_engine'

/** One object per response — never per result — describing what serving did. */
export interface RerankMeta {
  /** True only when the Jev order was actually returned; false means production order. */
  applied: boolean
  /** Present exactly when `applied` is false. */
  reason?: RerankFallbackReason
  /** Wall-clock for the whole re-rank attempt, in ms. */
  latency_ms: number
  /** Candidates the engine actually judged (errors and deadline misses excluded). */
  judged: number
  /** Mem0 shard candidates dropped before judging — see the module comment. */
  collapsed: number
  /** The deadline cut some judgments off; those candidates kept their production positions. */
  partial?: boolean
  /** Candidates not judged in time (present when `partial`). */
  unjudged?: number
}

export interface ServedRerankOutcome<C> {
  /** The full pool the caller should slice to `maxResults` — same length as `ranked`
   *  minus any collapsed duplicates, in the order to serve. */
  ordered: C[]
  meta: RerankMeta
  /** The row written to the decision log, or null when nothing ran the engine at all. */
  runRecord: ShadowRunRecord | null
}

export interface ServedRerankInput<C extends RankedRecallCandidate> {
  /** Null when no Jev credential route is configured — see `createJevDecisionEngineFromEnv`. */
  engine: DecisionEngine | null
  query: string
  /** The production ordering, best first. Never mutated. */
  ranked: C[]
  /** How many of the top-ranked candidates to judge. Defaults to `JEV_SHADOW_TOPK_DEFAULT`. */
  topK?: number
  /** Whole-batch deadline in ms; `0` disables it. Defaults to `KMS_JEV_RERANK_DEADLINE_MS`. */
  deadlineMs?: number
  sink?: DecisionLogSink | null
  now?: Date
  /**
   * Whether serving is enabled at all. Defaults to `true` — callers normally only invoke
   * this function once they've already checked `isJevServedRerankEnabled()`, so passing
   * `false` here is for exercising the `disabled` outcome directly (unit tests, or a
   * future per-request override) without a second call shape.
   */
  enabled?: boolean
}

/**
 * Drop a Mem0 shard whose parent KMS id (`mem0ParentId`) is ALSO a candidate in `ranked`
 * — the same entry twice, once as the full/graph copy and once as an LLM-extracted
 * fan-out sentence. The parent is always kept; only the shard is dropped. Order of the
 * survivors is preserved. A shard whose parent is NOT in the pool is left alone — there
 * is nothing to collapse it against.
 */
export function collapseMem0Duplicates<C extends RankedRecallCandidate>(ranked: C[]): { collapsed: C[], count: number } {
  const ids = new Set(ranked.map(c => String(c.id ?? '')))
  const collapsed: C[] = []
  let count = 0
  for (const candidate of ranked) {
    const id = String(candidate.id ?? '')
    const parentId = mem0ParentId((candidate as { metadata?: Record<string, unknown> | null }).metadata)
    if (parentId && parentId !== id && ids.has(parentId)) {
      count += 1
      continue
    }
    collapsed.push(candidate)
  }
  return { collapsed, count }
}

function fallback<C>(ranked: C[], reason: RerankFallbackReason, latencyMs: number, judged: number, collapsed: number): ServedRerankOutcome<C> {
  return {
    ordered: ranked,
    meta: { applied: false, reason, latency_ms: latencyMs, judged, collapsed },
    runRecord: null,
  }
}

/**
 * Judge the top-K candidates and return the order to serve. Never rejects, never takes
 * longer than the deadline (plus whatever a fault takes to be caught) — every failure
 * mode returns `ranked` unchanged with `meta.applied = false`.
 */
export async function runServedRerank<C extends RankedRecallCandidate>(input: ServedRerankInput<C>): Promise<ServedRerankOutcome<C>> {
  const startedAt = Date.now()

  if (input.enabled === false) {
    return fallback(input.ranked, 'disabled', 0, 0, 0)
  }
  if (!input.engine) {
    return fallback(input.ranked, 'no_engine', 0, 0, 0)
  }

  const now = input.now ?? new Date()
  const topK = input.topK ?? JEV_SHADOW_TOPK_DEFAULT
  const deadlineMs = input.deadlineMs ?? jevRerankDeadlineMs()
  const engine = input.engine

  // Collapse count survives into the catch block (a fault after this point still reports
  // how many duplicates would have been skipped), so it's read outside the try.
  let collapsedCount = 0
  try {
    // Only the top-K is judged; only the top-K is ever collapsed or reordered. Everything
    // beyond it keeps its production order and position, appended after the reranked
    // block. Slicing/collapsing is INSIDE the try: `input.ranked` is an untyped array
    // from a caller, and a poisoned getter or a hostile `.slice` override must cost a
    // fallback to production order, not an unhandled rejection.
    const head = input.ranked.slice(0, topK)
    const tail = input.ranked.slice(topK)
    const dedup = collapseMem0Duplicates(head)
    const dedupedHead = dedup.collapsed
    collapsedCount = dedup.count

    const { records, deadlineHit } = await evaluateRecallCandidates(engine, input.query, dedupedHead, now, deadlineMs)
    const latencyMs = Date.now() - startedAt
    const judged = records.filter(r => r.error === null).length

    // Keyed by position, not candidate id — same reasoning as runShadowRerank: the
    // permutation must stay a permutation even if two records share an id.
    const positions = shadowOrder(records.map((r, i) => ({
      id: String(i),
      shadowScore: r.policy_shadow_score,
      protected: r.policy_protected !== null,
    }))).map(Number)
    positions.forEach((position, i) => { records[position].policy_shadow_rank = i + 1 })

    const runRecord = buildRunRecord({
      engine, query: input.query, now, records, positions,
      poolSize: input.ranked.length, latencyMs, collapsedCount,
    })
    if (input.sink) {
      try {
        await input.sink.write(runRecord)
      } catch (e) {
        logger.warn(`decision: could not write served decision log: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (deadlineHit && judged === 0) {
      logger.warn(`decision: served rerank deadline ${deadlineMs}ms HIT with nothing judged — serving production order`)
      return { ordered: input.ranked, meta: { applied: false, reason: 'deadline', latency_ms: latencyMs, judged, collapsed: collapsedCount }, runRecord }
    }
    // A deadline hit with some judgments in hand still serves the policy order: the policy
    // never moves an unjudged candidate below its production position (shadowOrder), so the
    // late ones stay where production put them and only the judged ones are re-ranked. One
    // slow call — seen live, ~1 in 40 — must not throw away the other 19 judgments.
    const unjudged = records.length - judged
    const orderedHead = positions.map(position => dedupedHead[position])
    return {
      ordered: [...orderedHead, ...tail],
      meta: {
        applied: true, latency_ms: latencyMs, judged, collapsed: collapsedCount,
        ...(deadlineHit && { partial: true, unjudged }),
      },
      runRecord,
    }
  } catch (e) {
    // Whatever the SDK, the bucket, or a bug in the code above threw, and wasn't already
    // turned into a per-candidate error row: the search must not fail because of Jev.
    logger.warn(`decision: served rerank failed, serving production order: ${e instanceof Error ? e.message : String(e)}`)
    return fallback(input.ranked, 'error', Date.now() - startedAt, 0, collapsedCount)
  }
}

function buildRunRecord(args: {
  engine: DecisionEngine
  query: string
  now: Date
  records: CandidateDecisionRecord[]
  positions: number[]
  poolSize: number
  latencyMs: number
  collapsedCount: number
}): ShadowRunRecord {
  const { engine, query, now, records, positions, poolSize, latencyMs, collapsedCount } = args
  const succeeded = records.filter(r => r.error === null)
  const costs = succeeded.map(r => r.cost_usd_estimate)
  return {
    kind: 'recall_shadow_run',
    at: now.toISOString(),
    run_id: crypto.randomUUID(),
    provider: engine.provider,
    requested_model: engine.requestedModel,
    models: Array.from(new Set(succeeded.map(r => r.model).filter((m): m is string => m !== null))),
    question_schema_version: RECALL_EVIDENCE_V2_SCHEMA_VERSION,
    policy_version: SHADOW_POLICY_V2_VERSION,
    policy_decision: 'shadow_reorder',
    served: true,
    query,
    candidates_in_pool: poolSize,
    candidates_evaluated: records.length,
    candidates_failed: records.length - succeeded.length,
    latency_ms: latencyMs,
    usage: {
      input_tokens: succeeded.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0),
      output_tokens: succeeded.reduce((sum, r) => sum + (r.usage?.output_tokens ?? 0), 0),
    },
    cost_usd_estimate: costs.length > 0 && costs.every((c): c is number => c !== null)
      ? Number(costs.reduce((sum, c) => sum + c, 0).toFixed(8))
      : null,
    production_order: records.map(r => r.id),
    shadow_order: positions.map(position => records[position].id),
    candidates: records,
    collapsed_duplicates: collapsedCount,
  }
}
