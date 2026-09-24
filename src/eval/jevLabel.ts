/**
 * Jev labeller — grades one (query, candidate) pair 0/1/2 with a single Jev Choice
 * question, for `label-recall-pool.ts --labeler jev` and `jev-label-agreement.ts`.
 *
 * Why this exists: Gemma grading takes ~170 s/query (one full generation per candidate on
 * rym1); Jev answers the same question in ~200 ms via one System One request. The owner's
 * decision (2026-09-24) is to use Jev as the LABELLER for the full ~554-query pool, keeping
 * Gemma's existing 29+60 labels as an independent calibration set (see
 * `../scripts/jev-label-agreement.ts` for the agreement measurement between the two).
 *
 * Rubric: mirrors `gemmaGradePrompt`'s three levels VERBATIM (see
 * `../scripts/label-recall-pool.ts`) — a labeller swap must never itself explain a shift in
 * measured relevance. The option ids already carry the grade, so the numeral prefix
 * ("2 = ...") is dropped from the option text itself (it would be redundant next to the id,
 * and docs.typesafe.ai's Choice guidance asks for descriptions that separate options, not
 * restate their own name) — the substantive clause of each line is unchanged:
 *   grade_2 = "it directly answers the query or is essential context for acting on it"
 *   grade_1 = "related and somewhat useful, but does not answer it"
 *   grade_0 = "not useful (different topic, or only shares words)"
 *
 * Independence from Jev's OWN recall re-rank ranking (important — read before reusing this
 * question for anything else): `../decision/recallEvidence.ts`'s `RECALL_EVIDENCE_QUESTIONS_V2`
 * + `shadowPolicy.ts`'s `shadowScoreV2` is a SEPARATE machinery, judged independently per
 * candidate, that produces the "Jev v2 re-ranked order" reported by `label-recall-pool.ts`.
 * This module's labels are legitimately used to score BOTH production order and that v2
 * re-ranked order (owner decision, 2026-09-24, superseding an earlier draft rule that would
 * have excluded the v2 order from Jev-labelled reports) — the two are structurally distinct
 * Jev calls asking different questions, not the same judgment read twice. What must NEVER
 * happen is folding this module's `grade` INTO the v2 ranking score, or vice versa; they
 * stay separate fields (`PoolCandidateRow.grade` vs `PoolCandidateRow.jev.score`) all the
 * way through the pipeline.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { withEngineSlot } from '../decision/engineSlot.js'
import type { ChoiceDecisionQuestion, DecisionEngine } from '../decision/types.js'

export const JEV_LABEL_SCHEMA_VERSION = 'jev-recall-label/v1'

/** option id -> the 0/1/2 grade it represents. */
export const JEV_LABEL_GRADE_BY_OPTION: Readonly<Record<string, number>> = {
  grade_0: 0,
  grade_1: 1,
  grade_2: 2,
}

/**
 * ONE Choice question per (query, candidate). State is `{query, candidate}` with
 * `candidate` the capped content string directly (not a nested object) — literal per
 * docs.typesafe.ai's Choice guidance: no dates, no maths, the exact condition named in each
 * option. The caller caps content to 1500 chars (`capContent` / `CONTENT_CAP` in
 * `../scripts/label-recall-pool.ts`) before it ever reaches this module.
 */
export const JEV_LABEL_QUESTION: ChoiceDecisionQuestion = {
  type: 'choice',
  instructions: 'How useful is `candidate` for answering or acting on `query`?',
  criteria: {
    grade_2: 'The candidate directly answers the query, or is essential context for acting on it.',
    grade_1: 'The candidate is related and somewhat useful to the query, but does not answer it.',
    grade_0: 'The candidate is not useful for the query — it is about a different topic, or only shares words with the query without addressing what it asks.',
  },
}

export interface JevLabelState {
  query: string
  candidate: string
  [key: string]: string
}

/** `content` must already be capped by the caller (see module doc comment). */
export function jevLabelState(query: string, content: string): JevLabelState {
  return { query, candidate: content }
}

export interface JevLabelResult {
  /** argmax(probabilities), as 0/1/2. */
  grade: number
  /** The option id Jev returned (`grade_0`/`grade_1`/`grade_2`). */
  choice: string
  /** option id -> probability. Sums to 1. */
  probabilities: Record<string, number>
  /** Concentration of `probabilities`, in [0, 1]. Not correctness. */
  confidence: number
  /** sum(p(option) * grade(option)) — for threshold analysis independent of the argmax cut. */
  expectedGrade: number
  /** From `DecisionResult.costUsdEstimate` — an estimate from the configured price table,
   *  never a billed amount. Persisted so a re-run's report can sum real cost without
   *  re-calling Jev for cached pairs. */
  costUsdEstimate: number | null
  inputTokens: number
  outputTokens: number
}

/**
 * One Jev call, grading one (query, candidate) pair. Throws (never invents an answer) on a
 * malformed response or an option id outside `JEV_LABEL_GRADE_BY_OPTION` — same contract as
 * `judgeCandidateV2` in `../decision/recallEvidence.ts`: the caller decides what a failure
 * means, this function never guesses.
 */
export async function judgeJevLabel(engine: DecisionEngine, query: string, content: string): Promise<JevLabelResult> {
  const state = jevLabelState(query, content)
  const result = await withEngineSlot(() => engine.evaluate({ state, questions: { grade: JEV_LABEL_QUESTION } }))
  const answer = result.answers.grade
  if (!answer || answer.type !== 'choice') {
    throw new Error(`jev label: engine returned an answer of type "${String(answer?.type)}", expected "choice"`)
  }
  const grade = JEV_LABEL_GRADE_BY_OPTION[answer.choice]
  if (grade === undefined) {
    throw new Error(`jev label: unknown choice "${answer.choice}" — expected one of ${Object.keys(JEV_LABEL_GRADE_BY_OPTION).join(', ')}`)
  }
  let expectedGrade = 0
  for (const [option, p] of Object.entries(answer.probabilities)) {
    const g = JEV_LABEL_GRADE_BY_OPTION[option]
    if (g !== undefined) expectedGrade += p * g
  }
  return {
    grade,
    choice: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    expectedGrade,
    costUsdEstimate: result.costUsdEstimate,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  }
}

// ── cache (cache/jev-labels.jsonl) ──────────────────────────────────────────
//
// Same shape of cache as the Gemma grade cache and the Jev v2 score cache in
// `../scripts/label-recall-pool.ts` (JSONL, append-only, keyed by
// sha256(query, candidate id, content)) — a SEPARATE file and a SEPARATE key function
// (rather than importing `labelCacheKey` from that script) so this module has no import
// edge back into the script that imports it. `jevLabelCacheKey` computes the identical
// algorithm; `scripts-label-recall-pool.test.ts` / `jevLabel.test.ts` cross-check the two
// produce the same digest for the same inputs.

export function jevLabelCacheKey(query: string, candidateId: string, content: string): string {
  return crypto.createHash('sha256').update(query).update('\u0000').update(candidateId).update('\u0000').update(content).digest('hex')
}

export interface JevLabelCacheEntry extends JevLabelResult {}

export function loadJevLabelCache(filePath: string): Map<string, JevLabelCacheEntry> {
  const map = new Map<string, JevLabelCacheEntry>()
  if (!fs.existsSync(filePath)) return map
  for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const row = JSON.parse(line) as { key?: unknown } & Partial<JevLabelCacheEntry>
      if (typeof row.key === 'string' && typeof row.grade === 'number' && typeof row.choice === 'string') {
        const { key: _key, ...entry } = row
        map.set(row.key, entry as JevLabelCacheEntry)
      }
    } catch {
      // A partial tail line from a run in flight, or corruption — skip, don't fail the read.
    }
  }
  return map
}

export function appendJevLabelCacheEntry(filePath: string, key: string, entry: JevLabelCacheEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.appendFileSync(filePath, `${JSON.stringify({ key, ...entry })}\n`, { mode: 0o600 })
}
