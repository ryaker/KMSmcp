/**
 * Shadow recall rerank — Experiment 1 of the Jev/System One proposal.
 *
 * Takes the ordering `unified_search` already produced, asks a DecisionEngine three
 * questions about each of the top candidates, and writes what it learned to the decision
 * log. It returns a record; it does not return results. There is no code path from here
 * back into what a caller of `unified_search` receives, which is what makes this shadow
 * mode rather than a rerank with a flag in front of it.
 */

import crypto from 'crypto'
import { logger } from '../logger.js'
import type { CandidateDecisionRecord, DecisionLogSink, ShadowAction, ShadowRunRecord } from './decisionLog.js'
import { withEngineSlot } from './engineSlot.js'
import {
  EVIDENCE_VALUE_LEVELS,
  RECALL_EVIDENCE_QUESTIONS,
  RECALL_EVIDENCE_SCHEMA_VERSION,
  buildRecallState,
  fingerprintRecallState,
  type RecallCandidate,
  type RecallStatus,
} from './recallEvidence.js'
import { SHADOW_POLICY_VERSION, protectionReason, shadowOrder, shadowScore } from './shadowPolicy.js'
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
  const status = result.answers.status
  const evidenceValue = result.answers.evidence_value
  if (answersQuery?.type !== 'noul' || status?.type !== 'choice' || evidenceValue?.type !== 'score') {
    throw new Error('engine returned an answer of the wrong kind for a recall-evidence question')
  }
  return {
    answers_query: { jev_probability: answersQuery.probability },
    status: {
      choice: status.choice,
      jev_probabilities: status.probabilities,
      jev_confidence: status.confidence,
    },
    evidence_value: {
      score: evidenceValue.score,
      jev_probabilities: nameEvidenceLevels(evidenceValue.probabilities),
      jev_confidence: evidenceValue.confidence,
    },
  }
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

  const records = await Promise.all(evaluated.map((candidate, index) => withEngineSlot(async (): Promise<CandidateDecisionRecord> => {
    const callStarted = Date.now()
    // Everything that touches the candidate is inside the try. A retrieval result is an
    // untyped bag from three backends; one that throws while being read must cost one
    // row, not reject the run and discard the judgments already paid for.
    let base: Pick<CandidateDecisionRecord, 'id' | 'production_rank' | 'state_fingerprint' | 'content_truncated' | 'retrieval' | 'policy_protected' | 'policy_shadow_rank'> = {
      id: '',
      production_rank: index + 1,
      state_fingerprint: '',
      content_truncated: false,
      retrieval: { source_systems: [], retrieval_relevance: null, vector_similarity: null, ontology_score: null, knowledge_confidence: null },
      policy_protected: null,
      policy_shadow_rank: null,
    }
    try {
      const state = buildRecallState(input.query, candidate, now)
      base = {
        ...base,
        id: String(candidate.id ?? ''),
        state_fingerprint: fingerprintRecallState(state),
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

      const result = await input.engine.evaluate({ state, questions: RECALL_EVIDENCE_QUESTIONS })
      const jev = readJudgment(result)
      return {
        ...base,
        jev,
        policy_shadow_score: input.action === 'shadow_reorder'
          ? shadowScore({
              answersQuery: jev.answers_query.jev_probability,
              statusProbabilities: jev.status.jev_probabilities as Partial<Record<RecallStatus, number>>,
              evidenceValue: jev.evidence_value.score,
            })
          : null,
        model: result.model,
        request_id: result.requestId ?? null,
        latency_ms: result.latencyMs,
        usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens },
        cost_usd_estimate: result.costUsdEstimate,
        error: null,
      }
    } catch (e) {
      return {
        ...base,
        jev: null,
        policy_shadow_score: null,
        model: null,
        request_id: null,
        latency_ms: Date.now() - callStarted,
        usage: null,
        cost_usd_estimate: null,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      }
    }
  })))

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
    question_schema_version: RECALL_EVIDENCE_SCHEMA_VERSION,
    policy_version: SHADOW_POLICY_VERSION,
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
    ` (${run.usage.input_tokens} in-tok${run.cost_usd_estimate !== null ? `, ~$${run.cost_usd_estimate}` : ''})`
  )
  return run
}
