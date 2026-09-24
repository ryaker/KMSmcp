/**
 * Decision log — one JSON line per shadow run.
 *
 * A file, not the stderr logger: the point of shadow mode is an offline comparison
 * across many searches, and a distribution that scrolled past in a daemon log cannot be
 * joined to anything. Not a KMS entry either — writing judgments about retrieval back
 * into the store being retrieved from would put them in the next search's candidate pool.
 *
 * What a row deliberately does NOT contain: candidate content, or the state sent to the
 * engine. Rows carry ids and a state fingerprint. The log would otherwise be a second
 * copy of the knowledge base that `kms_supersede` / `kms_delete` never reach.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { logger } from '../logger.js'

export const DECISION_LOG_PATH_ENV = 'KMS_DECISION_LOG_PATH'
export const DECISION_LOG_DEFAULT_PATH = path.join(os.homedir(), '.kms', 'decision-log', 'recall-shadow.jsonl')

export type ShadowAction = 'shadow_log' | 'shadow_reorder'

/**
 * Per-candidate record. Field names carry their namespace: everything the engine said is
 * `jev_*`, everything retrieval said sits under `retrieval`, and what deterministic code
 * concluded is `policy_*`. There is no bare `confidence` or `score` anywhere in a row, so
 * a later reader cannot mistake one signal for another.
 *
 * `jev`'s shape is `recall-evidence/v2` (`question_schema_version` on the run record says
 * which version actually produced a given row — v1 rows already on disk were written under
 * an EARLIER shape of this same TS interface and are read as loosely-typed JSON, never
 * against this type; see `src/eval/shadowRunMetrics.ts`, which does not touch `.jev` at
 * all for exactly this reason).
 */
export interface CandidateDecisionRecord {
  id: string
  /** 1-based rank in the ordering production actually served. */
  production_rank: number
  /** sha256 of the state the engine saw (clock excluded). */
  state_fingerprint: string
  content_truncated: boolean
  /** Retrieval-side signals, copied verbatim for the offline join. Never engine output. */
  retrieval: {
    source_systems: string[]
    retrieval_relevance: number | null
    vector_similarity: number | null
    ontology_score: number | null
    /** The author's stored confidence in the fact. */
    knowledge_confidence: number | null
  }
  /** Null when the evaluation failed; see `error`. */
  jev: {
    answers_query: { jev_probability: number }
    evidence_value: {
      score: number
      /** Level name → probability, so a row is readable without the schema. */
      jev_probabilities: Record<string, number>
      jev_confidence: number
    }
    contradicts_premise: { jev_probability: number }
    contains_instruction: { jev_probability: number }
    describes_past_state: { jev_probability: number }
  } | null
  policy_protected: 'ontology_match' | 'lexical_match' | null
  /** Null unless the action is `shadow_reorder` and the candidate was judged. */
  policy_shadow_score: number | null
  /** 1-based rank in the shadow ordering. Null unless the action is `shadow_reorder`. */
  policy_shadow_rank: number | null
  /**
   * `contains_instruction` crossed `SHADOW_V2_INSTRUCTION_FLAG_THRESHOLD` (0.7). Logging
   * only — does not affect `policy_shadow_score` or the ordering. Null when unjudged.
   */
  policy_contains_instruction_flag: boolean | null
  /**
   * `contradicts_premise` crossed `SHADOW_V2_CONTRADICTION_FLAG_THRESHOLD` (0.7). For a
   * future "conflicts" routing block (R10); never affects the score. Null when unjudged.
   */
  policy_contradicts_premise_flag: boolean | null
  /** Raw P(describes_past_state = yes), clamped to [0, 1]. Logged, not thresholded, not scored. Null when unjudged. */
  policy_past_state_probability: number | null
  model: string | null
  request_id: string | null
  latency_ms: number
  usage: { input_tokens: number; output_tokens: number } | null
  cost_usd_estimate: number | null
  error: string | null
}

export interface ShadowRunRecord {
  kind: 'recall_shadow_run'
  at: string
  run_id: string
  provider: string
  requested_model: string
  /** Distinct resolved model ids seen across the run — normally exactly one. */
  models: string[]
  question_schema_version: string
  policy_version: string
  /** What deterministic code did with the judgments. Never anything but a shadow action. */
  policy_decision: ShadowAction
  /**
   * True when this ordering was actually returned to the `unified_search` caller
   * (`KMS_JEV_RERANK=1`, `src/decision/servedRerank.ts`). Absent/false for a shadow run
   * that only observed the ordering already served — the two share this log file and this
   * row shape, and this is the one field that tells them apart.
   */
  served?: boolean
  /**
   * Count of Mem0 shard candidates dropped before judging because their parent KMS id
   * (`mem0ParentId`) was also in the candidate pool — the same entry judged once, not
   * twice. Only a served run collapses; a shadow run leaves `undefined`.
   */
  collapsed_duplicates?: number
  /**
   * The query text. Unlike candidate content this IS logged: it is the join key to the
   * eval harness's relevance labels, it is not a stored entry any corrective tool could
   * later retract, and the file is 0600 on the machine that already holds the store.
   */
  query: string
  candidates_in_pool: number
  candidates_evaluated: number
  candidates_failed: number
  /** Wall-clock for the whole fan-out. */
  latency_ms: number
  usage: { input_tokens: number; output_tokens: number }
  cost_usd_estimate: number | null
  /** Ids in the order production served them (the evaluated slice only). */
  production_order: string[]
  /** Ids in the shadow ordering. Null unless the action is `shadow_reorder`. */
  shadow_order: string[] | null
  candidates: CandidateDecisionRecord[]
}

/** Where rows go. One sink per log file; the row type is that file's `kind`. */
export interface DecisionLogSink<Row = ShadowRunRecord> {
  write(record: Row): Promise<void>
}

export class JsonlDecisionLog<Row = ShadowRunRecord> implements DecisionLogSink<Row> {
  private ready: Promise<void> | null = null

  constructor(private readonly filePath: string) {}

  async write(record: Row): Promise<void> {
    if (!this.ready) this.ready = this.prepare()
    await this.ready
    await fs.promises.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  /**
   * Rows carry the query text, so the file must be owner-only. `appendFile`'s `mode`
   * applies ONLY when it creates the file — a log left behind 0644 by a restore, a
   * `touch`, or an older build would stay readable and keep collecting queries. So open
   * it once up front and chmod unconditionally. A failure here rejects every write: a
   * decision log that cannot be made private is not written at all.
   */
  private async prepare(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    const handle = await fs.promises.open(this.filePath, 'a', 0o600)
    try {
      await handle.chmod(0o600)
    } finally {
      await handle.close()
    }
  }
}

export function decisionLogFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionLogSink {
  const filePath = env[DECISION_LOG_PATH_ENV]?.trim() || DECISION_LOG_DEFAULT_PATH
  logger.info(`decision: shadow decision log → ${filePath}`)
  return new JsonlDecisionLog(filePath)
}
