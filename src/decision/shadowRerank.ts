/**
 * Shadow recall rerank — Experiment 1 of the Jev/System One proposal.
 *
 * Takes the ordering `unified_search` already produced, asks a DecisionEngine the
 * `recall-evidence/v2` questions about each of the top candidates, and writes what it
 * learned to the decision log. It returns a record; it does not return results. There is
 * no code path from here back into what a caller of `unified_search` receives, which is
 * what makes this shadow mode rather than a rerank with a flag in front of it.
 */

import crypto from 'crypto'
import { logger } from '../logger.js'
import type { CandidateDecisionRecord, DecisionLogSink, ShadowAction, ShadowRunRecord } from './decisionLog.js'
import { withEngineSlot } from './engineSlot.js'
import {
  EVIDENCE_VALUE_LEVELS,
  RECALL_EVIDENCE_QUESTIONS_V2,
  RECALL_EVIDENCE_V2_SCHEMA_VERSION,
  buildRecallStateV2,
  fingerprintRecallStateV2,
  isCandidateCorrectedOrReplaced,
  type RecallCandidate,
} from './recallEvidence.js'
import { SHADOW_POLICY_V2_VERSION, protectionReason, shadowOrder, shadowScoreV2 } from './shadowPolicy.js'
import type { DecisionEngine, DecisionResult } from './types.js'

/** Turns shadow evaluation on. Default OFF. Strictly `'1'`, like KMS_HYBRID_RETRIEVAL. */
export const JEV_SHADOW_RERANK_FLAG = 'KMS_JEV_SHADOW_RERANK'
/** With the flag above: also compute and log a shadow ordering (`shadow_reorder`). */
export const JEV_SHADOW_REORDER_FLAG = 'KMS_JEV_SHADOW_REORDER'
/** How many of the top-ranked candidates to evaluate per search. */
export const JEV_SHADOW_TOPK_ENV = 'KMS_JEV_SHADOW_TOPK'
export const JEV_SHADOW_TOPK_DEFAULT = 20
/** Hard ceiling — one request per candidate, so this bounds the cost of any one search. */
export const JEV_SHADOW_TOPK_MAX = 50

/**
 * One deadline for the whole search, in ms; `0` disables it. When it fires, the search's
 * single AbortController aborts every request still queued or in flight, and those
 * candidates are logged as unjudged — which the shadow policy already keeps at their
 * production position.
 *
 * Why 800 ms, although shadow mode answers nobody: the shadow log is the evidence for
 * serving, so it should measure what a served re-rank would actually get. Measured
 * uncapped, a 20-candidate search took p50 205 ms / p95 356 ms (per call p95 273 ms), so
 * 800 ms cuts off only the tail, and the unjudged count per run becomes the deadline-miss
 * rate a served path would see. Set it to 0 to record every judgment however late (the
 * pre-2026-09-24 behaviour, bounded only by the engine's per-attempt timeout).
 */
export const JEV_RERANK_DEADLINE_ENV = 'KMS_JEV_RERANK_DEADLINE_MS'
export const JEV_RERANK_DEADLINE_DEFAULT_MS = 800

export function isJevShadowRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_SHADOW_RERANK_FLAG] === '1'
}

export function jevShadowAction(env: NodeJS.ProcessEnv = process.env): ShadowAction {
  return env[JEV_SHADOW_REORDER_FLAG] === '1' ? 'shadow_reorder' : 'shadow_log'
}

export function jevShadowTopK(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[JEV_SHADOW_TOPK_ENV])
  if (!Number.isInteger(parsed) || parsed < 1) return JEV_SHADOW_TOPK_DEFAULT
  return Math.min(parsed, JEV_SHADOW_TOPK_MAX)
}

export function jevRerankDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[JEV_RERANK_DEADLINE_ENV]
  if (raw === undefined || raw.trim() === '') return JEV_RERANK_DEADLINE_DEFAULT_MS
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : JEV_RERANK_DEADLINE_DEFAULT_MS
}

/** A ranked retrieval result, as `unified_search` holds it just before slicing. */
export interface RankedRecallCandidate extends RecallCandidate {
  sourceSystem?: string
  _sourceSystems?: string[]
  confidence?: number
  _relevance?: number
  _vectorSimilarity?: number
  _ontologyScore?: number
}

export interface ShadowRerankInput {
  engine: DecisionEngine
  query: string
  /** The production ordering, best first. Not mutated. */
  ranked: RankedRecallCandidate[]
  action: ShadowAction
  topK?: number
  sink?: DecisionLogSink | null
  now?: Date
  /** Whole-search deadline in ms; `0` disables. Defaults to `KMS_JEV_RERANK_DEADLINE_MS`, else 800. */
  deadlineMs?: number
}

class DeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`not judged within the ${deadlineMs}ms search deadline`)
    this.name = 'DeadlineExceeded'
  }
}

/**
 * Settle with `promise`, or reject as soon as `signal` fires — whichever is first. The
 * SDK aborts its request on the signal too; this is what guarantees the run ends at the
 * deadline even if an engine ignores it.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) }
    )
  })
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Level index → level name, so a logged distribution reads without the schema open. */
function nameEvidenceLevels(byIndex: Record<string, number>): Record<string, number> {
  const named: Record<string, number> = {}
  for (const [index, p] of Object.entries(byIndex)) {
    named[EVIDENCE_VALUE_LEVELS[Number(index)] ?? `level_${index}`] = p
  }
  return named
}

function readJudgment(result: DecisionResult): NonNullable<CandidateDecisionRecord['jev']> {
  const answersQuery = result.answers.answers_query
  const evidenceValue = result.answers.evidence_value
  const contradictsPremise = result.answers.contradicts_premise
  const containsInstruction = result.answers.contains_instruction
  const describesPastState = result.answers.describes_past_state
  if (
    answersQuery?.type !== 'noul' ||
    evidenceValue?.type !== 'score' ||
    contradictsPremise?.type !== 'noul' ||
    containsInstruction?.type !== 'noul' ||
    describesPastState?.type !== 'noul'
  ) {
    throw new Error('engine returned an answer of the wrong kind for a recall-evidence/v2 question')
  }
  return {
    answers_query: { jev_probability: answersQuery.probability },
    evidence_value: {
      score: evidenceValue.score,
      jev_probabilities: nameEvidenceLevels(evidenceValue.probabilities),
      jev_confidence: evidenceValue.confidence,
    },
    contradicts_premise: { jev_probability: contradictsPremise.probability },
    contains_instruction: { jev_probability: containsInstruction.probability },
    describes_past_state: { jev_probability: describesPastState.probability },
  }
}

/** One candidate's evaluation — everything `runShadowRerank` and the served re-rank
 *  (`servedRerank.ts`) both need, independent of what either does with the result.
 *  `policy_shadow_score` is always computed when a judgment succeeds; a caller that only
 *  wants it under `shadow_reorder` (the logged-shadow contract, pinned by
 *  `UnifiedSearchTool.shadowRerank.test.ts`) nulls it back out itself. */
async function evaluateOneCandidate(
  engine: DecisionEngine,
  query: string,
  candidate: RankedRecallCandidate,
  index: number,
  now: Date,
  signal: AbortSignal
): Promise<CandidateDecisionRecord> {
  const callStarted = Date.now()
  // Everything that touches the candidate is inside the try. A retrieval result is an
  // untyped bag from three backends; one that throws while being read must cost one
  // row, not reject the run and discard the judgments already paid for.
  let base: Pick<
    CandidateDecisionRecord,
    | 'id'
    | 'production_rank'
    | 'state_fingerprint'
    | 'content_truncated'
    | 'retrieval'
    | 'policy_protected'
    | 'policy_shadow_rank'
  > = {
    id: '',
    production_rank: index + 1,
    state_fingerprint: '',
    content_truncated: false,
    retrieval: { source_systems: [], retrieval_relevance: null, vector_similarity: null, ontology_score: null, knowledge_confidence: null },
    policy_protected: null,
    policy_shadow_rank: null,
  }
  try {
    const state = buildRecallStateV2(query, candidate)
    // Code-known, not asked of Jev (R7): the same metadata v1's `status` Choice used to
    // judge `superseded_context` from is read directly here.
    const correctedOrReplaced = isCandidateCorrectedOrReplaced(candidate)
    base = {
      ...base,
      id: String(candidate.id ?? ''),
      state_fingerprint: fingerprintRecallStateV2(state),
      content_truncated: (state as { candidate: { content_truncated: boolean } }).candidate.content_truncated,
      retrieval: {
        source_systems: candidate._sourceSystems ?? (candidate.sourceSystem ? [candidate.sourceSystem] : []),
        retrieval_relevance: finiteOrNull(candidate._relevance),
        vector_similarity: finiteOrNull(candidate._vectorSimilarity),
        ontology_score: finiteOrNull(candidate._ontologyScore),
        knowledge_confidence: finiteOrNull(candidate.confidence),
      },
      policy_protected: protectionReason(candidate),
    }

    // The rate-limit wait is inside the try and under the deadline: a candidate still
    // queued when the deadline fires, or refused by a full queue, is one unjudged row.
    const result = await untilAborted(
      withEngineSlot(() => engine.evaluate({ state, questions: RECALL_EVIDENCE_QUESTIONS_V2, signal }), { signal }),
      signal
    )
    const jev = readJudgment(result)
    const scored = shadowScoreV2({
      answersQuery: jev.answers_query.jev_probability,
      evidenceValue: jev.evidence_value.score,
      containsInstruction: jev.contains_instruction.jev_probability,
      describesPastState: jev.describes_past_state.jev_probability,
      contradictsPremise: jev.contradicts_premise.jev_probability,
      correctedOrReplaced,
    })
    return {
      ...base,
      jev,
      policy_shadow_score: scored.score,
      policy_contains_instruction_flag: scored.containsInstructionFlag,
      policy_contradicts_premise_flag: scored.contradictsPremiseFlag,
      policy_past_state_probability: scored.describesPastStateProbability,
      model: result.model,
      request_id: result.requestId ?? null,
      latency_ms: result.latencyMs,
      usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens },
      cost_usd_estimate: result.costUsdEstimate,
      error: null,
    }
  } catch (e) {
    // Whatever the SDK or the bucket threw on abort, a deadline miss is logged as one.
    const cause = signal.aborted && signal.reason instanceof DeadlineExceededError ? signal.reason : e
    return {
      ...base,
      jev: null,
      policy_shadow_score: null,
      policy_contains_instruction_flag: null,
      policy_contradicts_premise_flag: null,
      policy_past_state_probability: null,
      model: null,
      request_id: null,
      latency_ms: Date.now() - callStarted,
      usage: null,
      cost_usd_estimate: null,
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    }
  }
}

export interface EvaluateCandidatesResult {
  records: CandidateDecisionRecord[]
  /** Whether the whole-batch deadline fired before every candidate settled. */
  deadlineHit: boolean
}

/**
 * Judge `evaluated` against `query`, one request per candidate, under one whole-batch
 * deadline. Shared by `runShadowRerank` (fire-and-forget, logged) and `servedRerank.ts`
 * (awaited, served) — everything about talking to the engine lives here exactly once.
 */
export async function evaluateRecallCandidates(
  engine: DecisionEngine,
  query: string,
  evaluated: RankedRecallCandidate[],
  now: Date,
  deadlineMs: number
): Promise<EvaluateCandidatesResult> {
  const controller = new AbortController()
  const { signal } = controller
  const deadlineTimer = deadlineMs > 0
    ? setTimeout(() => controller.abort(new DeadlineExceededError(deadlineMs)), deadlineMs)
    : null

  const records = await Promise.all(
    evaluated.map((candidate, index) => evaluateOneCandidate(engine, query, candidate, index, now, signal))
  )
  if (deadlineTimer) clearTimeout(deadlineTimer)
  return { records, deadlineHit: signal.aborted }
}

/**
 * Evaluate the top candidates and log the run. A failed candidate — whether the engine
 * failed or the candidate itself could not be read — is a row with `error` set; a failed
 * log write is a warning. Neither rejects. The search that triggered this has already
 * been answered by the time any of it matters.
 */
export async function runShadowRerank(input: ShadowRerankInput): Promise<ShadowRunRecord> {
  const started = Date.now()
  const now = input.now ?? new Date()
  const evaluated = input.ranked.slice(0, input.topK ?? JEV_SHADOW_TOPK_DEFAULT)

  const deadlineMs = input.deadlineMs ?? jevRerankDeadlineMs()
  const { records, deadlineHit } = await evaluateRecallCandidates(input.engine, input.query, evaluated, now, deadlineMs)

  // `policy_shadow_score` is always computed by evaluateOneCandidate; the logged-shadow
  // contract only ever reported it under `shadow_reorder` (see
  // `UnifiedSearchTool.shadowRerank.test.ts`: "logs every field the brief requires"
  // asserts `policy_shadow_score: null` under `shadow_log`), so a plain log run nulls it
  // back out rather than exposing a number nobody asked to log a policy decision on.
  if (input.action !== 'shadow_reorder') {
    for (const r of records) r.policy_shadow_score = null
  }
  const unjudgedByDeadline = records.filter(r => r.error?.startsWith('DeadlineExceeded:')).length

  let order: string[] | null = null
  if (input.action === 'shadow_reorder') {
    // Keyed by position, not by candidate id: the permutation must stay a permutation
    // even if a backend ever hands back two results with the same id.
    const positions = shadowOrder(records.map((r, i) => ({
      id: String(i),
      shadowScore: r.policy_shadow_score,
      protected: r.policy_protected !== null,
    }))).map(Number)
    positions.forEach((position, i) => { records[position].policy_shadow_rank = i + 1 })
    order = positions.map(position => records[position].id)
  }

  const succeeded = records.filter(r => r.error === null)
  const costs = succeeded.map(r => r.cost_usd_estimate)
  const run: ShadowRunRecord = {
    kind: 'recall_shadow_run',
    at: now.toISOString(),
    run_id: crypto.randomUUID(),
    provider: input.engine.provider,
    requested_model: input.engine.requestedModel,
    models: Array.from(new Set(succeeded.map(r => r.model).filter((m): m is string => m !== null))),
    question_schema_version: RECALL_EVIDENCE_V2_SCHEMA_VERSION,
    policy_version: SHADOW_POLICY_V2_VERSION,
    policy_decision: input.action,
    query: input.query,
    candidates_in_pool: input.ranked.length,
    candidates_evaluated: records.length,
    candidates_failed: records.length - succeeded.length,
    latency_ms: Date.now() - started,
    usage: {
      input_tokens: succeeded.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0),
      output_tokens: succeeded.reduce((sum, r) => sum + (r.usage?.output_tokens ?? 0), 0),
    },
    // Null when ANY contributing estimate is null — a partial sum would read as a total.
    cost_usd_estimate: costs.length > 0 && costs.every((c): c is number => c !== null)
      ? Number(costs.reduce((sum, c) => sum + c, 0).toFixed(8))
      : null,
    production_order: records.map(r => r.id),
    shadow_order: order,
    candidates: records,
  }

  if (input.sink) {
    try {
      await input.sink.write(run)
    } catch (e) {
      logger.warn(`decision: could not write shadow decision log: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  logger.info(
    `decision: ${run.policy_decision} ${run.candidates_evaluated - run.candidates_failed}/${run.candidates_evaluated} judged in ${run.latency_ms}ms` +
    ` (${run.usage.input_tokens} in-tok${run.cost_usd_estimate !== null ? `, ~$${run.cost_usd_estimate}` : ''})` +
    (deadlineMs > 0
      ? deadlineHit
        ? `; deadline ${deadlineMs}ms HIT, ${unjudgedByDeadline} unjudged`
        : `; within ${deadlineMs}ms deadline`
      : '; no deadline')
  )
  return run
}
