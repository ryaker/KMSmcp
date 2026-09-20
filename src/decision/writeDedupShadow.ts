/**
 * Shadow write-time dedup — Experiment 2 of the Jev/System One proposal.
 *
 * Takes the candidates the dedup gate (DG-T1-B) already found for a `unified_store` call,
 * asks a DecisionEngine how the new assertion relates to each, runs the deterministic
 * policy over the answers, and writes what it learned to a decision log. It returns a
 * record; it does not return a store result, and it is handed no storage handle that can
 * write. There is no code path from here back into what `unified_store` stores, refuses,
 * supersedes or returns — which is what makes this shadow mode rather than a gate with a
 * flag in front of it.
 */

import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { logger } from '../logger.js'
import { JsonlDecisionLog, type DecisionLogSink } from './decisionLog.js'
import { withEngineSlot } from './engineSlot.js'
import {
  WRITE_DEDUP_POLICY_VERSION,
  aggregateWriteDedupProposals,
  proposeWriteDedupAction,
  type WriteDedupProposal,
} from './writeDedupPolicy.js'
import {
  WRITE_DEDUP_NOULS,
  WRITE_DEDUP_QUESTIONS,
  WRITE_DEDUP_SCHEMA_VERSION,
  buildWriteDedupState,
  fingerprintWriteDedupState,
  type WriteDedupNoul,
  type WriteDedupRelation,
} from './writeDedupRelation.js'
import type { DecisionEngine, DecisionResult } from './types.js'

/** Turns shadow evaluation on. Default OFF. Strictly `'1'`, like KMS_JEV_SHADOW_RERANK. */
export const JEV_WRITE_DEDUP_FLAG = 'KMS_JEV_WRITE_DEDUP'
/**
 * Reserved for bounded automatic actions. Hard-disabled: `WRITE_DEDUP_AUTO_ACTIONS` is
 * empty, so setting this changes one logged boolean and nothing else.
 */
export const JEV_WRITE_DEDUP_ACT_FLAG = 'KMS_JEV_WRITE_DEDUP_ACT'
/**
 * Candidates below this cosine are not judged. The gate's confirm band starts at 0.78; the
 * default reaches below it on purpose, because the pairs the gate waved through are where
 * its false negatives (a contradiction that embedded at 0.7) would be.
 */
export const JEV_WRITE_DEDUP_MIN_SIM_ENV = 'KMS_JEV_WRITE_DEDUP_MIN_SIM'
export const JEV_WRITE_DEDUP_MIN_SIM_DEFAULT = 0.6
/** Hard ceiling — one request per candidate, so this bounds the cost of any one write. */
export const JEV_WRITE_DEDUP_MAX_CANDIDATES = 5

export const WRITE_DEDUP_LOG_PATH_ENV = 'KMS_WRITE_DEDUP_LOG_PATH'
export const WRITE_DEDUP_LOG_DEFAULT_PATH = path.join(os.homedir(), '.kms', 'decision-log', 'write-dedup-shadow.jsonl')

export function isJevWriteDedupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_WRITE_DEDUP_FLAG] === '1'
}

export function isJevWriteDedupActRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_WRITE_DEDUP_ACT_FLAG] === '1'
}

export function jevWriteDedupMinSimilarity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[JEV_WRITE_DEDUP_MIN_SIM_ENV]
  if (raw === undefined || raw.trim() === '') return JEV_WRITE_DEDUP_MIN_SIM_DEFAULT
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : JEV_WRITE_DEDUP_MIN_SIM_DEFAULT
}

/** What the production gate did with this write. Copied for the offline join; never engine output. */
export interface WriteDedupGateOutcome {
  outcome: 'proceeded' | 'dedup_required'
  band: 'refuse' | 'confirm' | null
  thresholds: { refuse: number; confirm: number }
}

export interface WriteDedupShadowCandidate {
  id: string
  vectorSimilarity: number
  /** The Tier 2 (Haiku) judge's relation for this candidate, when it produced one. */
  tier2Relation: string | null
  contentPreview: string
  contentType?: string
  subject?: string
}

/** Full entry lookup — read-only. Returns null when the entry cannot be found. */
export type WriteDedupHydrate = (id: string) => Promise<{ content?: unknown; metadata?: unknown } | null | undefined>

export interface WriteDedupShadowInput {
  engine: DecisionEngine
  assertion: { entryId: string; content: string; contentType?: string; subject?: string; userId?: string }
  gate: WriteDedupGateOutcome
  /** The gate's candidates, most similar first. Not mutated. */
  candidates: readonly WriteDedupShadowCandidate[]
  hydrate?: WriteDedupHydrate
  minSimilarity?: number
  actRequested?: boolean
  sink?: DecisionLogSink<WriteDedupLogRow> | null
  now?: Date
}

/**
 * Per-candidate record. Same namespacing rule as the recall log: everything the engine
 * said is `jev_*`, the embedder's signal is `vector_similarity`, the Tier 2 judge's is
 * `tier2_llm_relation`, and what deterministic code concluded is `policy_*`.
 */
export interface WriteDedupCandidateRecord {
  id: string
  vector_similarity: number
  /** Where this candidate sat relative to the gate's thresholds. */
  gate_band: 'refuse' | 'confirm' | 'below_confirm'
  tier2_llm_relation: string | null
  /** sha256 of the state the engine saw. */
  state_fingerprint: string
  content_truncated: boolean
  /** Null when the evaluation failed; see `error`. */
  jev: {
    relation: {
      choice: WriteDedupRelation | string
      jev_probabilities: Record<string, number>
      jev_confidence: number
    }
    nouls: Record<WriteDedupNoul, { jev_probability: number }>
  } | null
  policy_proposal: WriteDedupProposal | null
  policy_reasons: string[]
  model: string | null
  request_id: string | null
  latency_ms: number
  usage: { input_tokens: number; output_tokens: number } | null
  cost_usd_estimate: number | null
  error: string | null
}

export interface WriteDedupRunRecord {
  kind: 'write_dedup_shadow_run'
  at: string
  run_id: string
  provider: string
  requested_model: string
  /** Distinct resolved model ids seen across the run — normally exactly one. */
  models: string[]
  question_schema_version: string
  policy_version: string
  /** What deterministic code did with the judgments. Never anything but `shadow_log`. */
  policy_decision: 'shadow_log'
  /** Whether KMS_JEV_WRITE_DEDUP_ACT=1 was set. It is ignored; this records that it was asked. */
  act_requested: boolean
  /**
   * The new assertion, by reference only. No content: if the write proceeds it becomes a
   * KMS entry that `kms_supersede` / `kms_delete` may later retire, and a copy here would
   * outlive that. `content_sha256` joins this row to its `write_dedup_resolution` row.
   */
  assertion: {
    /** The id this write was assigned. Only a stored entry's id when `gate.outcome` is `proceeded`. */
    entry_id: string
    content_sha256: string
    content_chars: number
    content_type: string | null
    subject: string | null
    user_id: string | null
  }
  gate: WriteDedupGateOutcome
  candidates_in_pool: number
  candidates_evaluated: number
  candidates_failed: number
  /** Wall-clock for the whole fan-out. */
  latency_ms: number
  usage: { input_tokens: number; output_tokens: number }
  cost_usd_estimate: number | null
  /** Most consequential per-candidate proposal. Null when no candidate was judged. */
  policy_proposal: WriteDedupProposal | null
  policy_proposal_target_id: string | null
  candidates: WriteDedupCandidateRecord[]
}

/**
 * What the caller actually did after a `dedup_required` — the label the proposals are
 * scored against. Written when `unified_store` is retried with an `action`; joins to the
 * shadow run on `assertion.content_sha256`. The caller's free-text `reason` is not logged.
 */
export interface WriteDedupResolutionRecord {
  kind: 'write_dedup_resolution'
  at: string
  assertion: { content_sha256: string; content_chars: number }
  caller_action: 'supersede' | 'update' | 'complement' | 'force-new'
  /** `old_id` for supersede/update, `related_to` for complement, null for force-new. */
  target_id: string | null
}

export type WriteDedupLogRow = WriteDedupRunRecord | WriteDedupResolutionRecord

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

export function writeDedupLogFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionLogSink<WriteDedupLogRow> {
  const filePath = env[WRITE_DEDUP_LOG_PATH_ENV]?.trim() || WRITE_DEDUP_LOG_DEFAULT_PATH
  logger.info(`decision: write-dedup shadow log → ${filePath}`)
  return new JsonlDecisionLog<WriteDedupLogRow>(filePath)
}

function readJudgment(result: DecisionResult): NonNullable<WriteDedupCandidateRecord['jev']> {
  const relation = result.answers.relation
  if (relation?.type !== 'choice') {
    throw new Error('engine returned an answer of the wrong kind for the write-dedup relation question')
  }
  const nouls = {} as Record<WriteDedupNoul, { jev_probability: number }>
  for (const id of WRITE_DEDUP_NOULS) {
    const answer = result.answers[id]
    if (answer?.type !== 'noul') throw new Error(`engine returned an answer of the wrong kind for write-dedup question "${id}"`)
    nouls[id] = { jev_probability: answer.probability }
  }
  return {
    relation: { choice: relation.choice, jev_probabilities: relation.probabilities, jev_confidence: relation.confidence },
    nouls,
  }
}

function gateBand(similarity: number, thresholds: { refuse: number; confirm: number }): WriteDedupCandidateRecord['gate_band'] {
  if (similarity >= thresholds.refuse) return 'refuse'
  return similarity >= thresholds.confirm ? 'confirm' : 'below_confirm'
}

/**
 * Judge the gate's candidates and log the run. A failed candidate — whether the engine
 * failed or the candidate could not be read — is a row with `error` set; a failed log
 * write is a warning. Neither rejects. The `unified_store` call that triggered this has
 * already been answered by the time any of it matters.
 */
export async function runWriteDedupShadow(input: WriteDedupShadowInput): Promise<WriteDedupRunRecord> {
  const started = Date.now()
  const now = input.now ?? new Date()
  const minSimilarity = input.minSimilarity ?? JEV_WRITE_DEDUP_MIN_SIM_DEFAULT
  const evaluated = input.candidates
    .filter(c => c.vectorSimilarity >= minSimilarity)
    .slice(0, JEV_WRITE_DEDUP_MAX_CANDIDATES)

  const records = await Promise.all(evaluated.map(candidate => withEngineSlot(async (): Promise<WriteDedupCandidateRecord> => {
    const callStarted = Date.now()
    let base: Pick<WriteDedupCandidateRecord, 'id' | 'vector_similarity' | 'gate_band' | 'tier2_llm_relation' | 'state_fingerprint' | 'content_truncated'> = {
      id: String(candidate.id ?? ''),
      vector_similarity: candidate.vectorSimilarity,
      gate_band: gateBand(candidate.vectorSimilarity, input.gate.thresholds),
      tier2_llm_relation: candidate.tier2Relation,
      state_fingerprint: '',
      content_truncated: false,
    }
    try {
      // The gate's preview is capped at 200 chars, which is not enough to tell a
      // restatement from an update. Read the whole entry; fall back to the preview, and
      // say so in the state, only when it cannot be read.
      let content = candidate.contentPreview
      let contentIsPreview = true
      let metadata: Record<string, unknown> | null = null
      if (input.hydrate) {
        try {
          const entry = await input.hydrate(candidate.id)
          if (entry && typeof entry.content === 'string' && entry.content.length > 0) {
            content = entry.content
            contentIsPreview = false
          }
          if (entry?.metadata && typeof entry.metadata === 'object') metadata = entry.metadata as Record<string, unknown>
        } catch {
          // Non-fatal — judge the preview.
        }
      }

      const state = buildWriteDedupState(
        { content: input.assertion.content, contentType: input.assertion.contentType, subject: input.assertion.subject },
        { content, contentIsPreview, contentType: candidate.contentType, subject: candidate.subject, metadata }
      )
      base = {
        ...base,
        state_fingerprint: fingerprintWriteDedupState(state),
        content_truncated:
          (state as { new_assertion: { content_truncated: boolean } }).new_assertion.content_truncated ||
          (state as { candidate: { content_truncated: boolean } }).candidate.content_truncated,
      }

      const result = await input.engine.evaluate({ state, questions: WRITE_DEDUP_QUESTIONS })
      const jev = readJudgment(result)
      const proposed = proposeWriteDedupAction({
        relation: {
          choice: jev.relation.choice,
          probabilities: jev.relation.jev_probabilities,
          confidence: jev.relation.jev_confidence,
        },
        nouls: Object.fromEntries(WRITE_DEDUP_NOULS.map(id => [id, jev.nouls[id].jev_probability])) as Record<WriteDedupNoul, number>,
      })
      return {
        ...base,
        jev,
        policy_proposal: proposed.proposal,
        policy_reasons: proposed.reasons,
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
        policy_proposal: null,
        policy_reasons: [],
        model: null,
        request_id: null,
        latency_ms: Date.now() - callStarted,
        usage: null,
        cost_usd_estimate: null,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      }
    }
  })))

  const succeeded = records.filter(r => r.error === null)
  const costs = succeeded.map(r => r.cost_usd_estimate)
  const aggregate = aggregateWriteDedupProposals(records.map(r => ({ id: r.id, proposal: r.policy_proposal })))
  const run: WriteDedupRunRecord = {
    kind: 'write_dedup_shadow_run',
    at: now.toISOString(),
    run_id: crypto.randomUUID(),
    provider: input.engine.provider,
    requested_model: input.engine.requestedModel,
    models: Array.from(new Set(succeeded.map(r => r.model).filter((m): m is string => m !== null))),
    question_schema_version: WRITE_DEDUP_SCHEMA_VERSION,
    policy_version: WRITE_DEDUP_POLICY_VERSION,
    policy_decision: 'shadow_log',
    act_requested: input.actRequested === true,
    assertion: {
      entry_id: input.assertion.entryId,
      content_sha256: sha256(input.assertion.content),
      content_chars: input.assertion.content.length,
      content_type: input.assertion.contentType ?? null,
      subject: input.assertion.subject ?? null,
      user_id: input.assertion.userId ?? null,
    },
    gate: input.gate,
    candidates_in_pool: input.candidates.length,
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
    policy_proposal: aggregate?.proposal ?? null,
    policy_proposal_target_id: aggregate?.targetId ?? null,
    candidates: records,
  }

  // A run that judged nothing (every candidate under the similarity floor) is not a row.
  if (records.length === 0) return run

  if (input.sink) {
    try {
      await input.sink.write(run)
    } catch (e) {
      logger.warn(`decision: could not write write-dedup shadow log: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  logger.info(
    `decision: write-dedup shadow_log ${succeeded.length}/${records.length} judged in ${run.latency_ms}ms` +
    ` → ${run.policy_proposal ?? 'no proposal'} (gate: ${run.gate.outcome}; ${run.usage.input_tokens} in-tok` +
    `${run.cost_usd_estimate !== null ? `, ~$${run.cost_usd_estimate}` : ''})`
  )
  return run
}

export function buildWriteDedupResolution(
  args: { content: string; action: WriteDedupResolutionRecord['caller_action']; old_id?: string; related_to?: string },
  now: Date = new Date()
): WriteDedupResolutionRecord {
  return {
    kind: 'write_dedup_resolution',
    at: now.toISOString(),
    assertion: { content_sha256: sha256(args.content), content_chars: args.content.length },
    caller_action: args.action,
    target_id: (args.action === 'complement' ? args.related_to : args.action === 'force-new' ? undefined : args.old_id) ?? null,
  }
}
