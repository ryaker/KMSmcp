/**
 * Recall evidence evaluation — the three judgments asked about one (query, candidate)
 * pair, and the state they are asked over.
 *
 * One request per candidate, all three questions together: they share a state, they are
 * independent of each other, and the provider evaluates them in parallel. A candidate
 * never sees another candidate, so a judgment about one cannot be contaminated by the
 * ordering the ranker happened to produce.
 *
 * None of the questions asks "should this be ranked higher?". That call belongs to
 * `shadowPolicy.ts`, where changing it means editing a number, not rewording a question
 * and invalidating every logged answer.
 */

import { fingerprintState } from './stateFingerprint.js'
import type {
  ChoiceDecisionQuestion,
  DecisionJson,
  NoulDecisionQuestion,
  ScoreDecisionQuestion,
} from './types.js'

/**
 * Bump on ANY change to instructions, criteria, option ids, level order, or the state
 * shape. Answers logged under different versions are not comparable, and the version is
 * the only thing that lets an analysis tell them apart.
 */
export const RECALL_EVIDENCE_SCHEMA_VERSION = 'recall-evidence/v1'

export const RECALL_STATUS_OPTIONS = [
  'current',
  'historical',
  'superseded_context',
  'contradictory',
  'irrelevant',
] as const
export type RecallStatus = (typeof RECALL_STATUS_OPTIONS)[number]

/** Ordered lowest → highest. The index is the Score level the provider reports. */
export const EVIDENCE_VALUE_LEVELS = [
  'no_support',
  'topical_only',
  'indirect',
  'partial',
  'direct',
] as const
export type EvidenceValueLevel = (typeof EVIDENCE_VALUE_LEVELS)[number]
export const EVIDENCE_VALUE_MAX = EVIDENCE_VALUE_LEVELS.length - 1

const answersQuery: NoulDecisionQuestion = {
  type: 'noul',
  instructions:
    'Does `candidate.content` contain information that answers what `query` is asking for?',
  criteria: {
    true: 'The candidate states information that could be used, as written, in an answer to the query.',
    false:
      'The candidate is about something else, or shares words or a topic with the query without supplying what the query asks for.',
  },
}

// The options are worded to be mutually exclusive, because two of the pairs are not
// naturally so: an entry can be true today AND dispute the query's premise, and a
// corrected entry necessarily describes the past. Each description therefore names the
// neighbour it excludes, and the instructions give the precedence — otherwise which
// bucket an ambiguous entry lands in is model idiosyncrasy, and `historical` (×0.8) vs
// `superseded_context` (×0.5) is a real difference in the shadow score.
const status: ChoiceDecisionQuestion = {
  type: 'choice',
  instructions:
    'The candidate is a stored memory entry retrieved for `query`. `today` is the current date and `candidate.stored_at` is when the entry was written. Judged from the candidate\'s own wording and its metadata, what is the standing of this entry as evidence for the query? Decide in this order and take the first that applies: irrelevant, then contradictory, then superseded_context, then historical, then current.',
  criteria: {
    irrelevant: 'Not about the subject of the query.',
    contradictory:
      'About the subject of the query, and conflicts with a factual premise stated in the query, or makes claims that conflict with each other on the point the query asks about. Applies whether or not the entry is itself up to date.',
    superseded_context:
      'About the subject of the query and consistent with its premise, but the entry itself or its metadata (`candidate.correction_flag`, `candidate.replaced_by_later_entry`) says it was corrected, replaced, retracted, or found wrong.',
    historical:
      'About the subject of the query and consistent with its premise, not marked as corrected or replaced, but explicitly describes a past state, event, or dated measurement rather than how things stand now.',
    current:
      'About the subject of the query and consistent with its premise, and presents its information as true or applicable now, with nothing indicating it has been corrected or has since changed.',
  },
}

const evidenceValue: ScoreDecisionQuestion = {
  type: 'score',
  instructions:
    'How much does `candidate.content` contribute to answering `query`?',
  // Each level has to describe a concrete situation and stand on its own — the provider
  // places probability on levels independently, it does not interpolate between labels.
  criteria: [
    'The candidate contains nothing that helps answer the query.',
    'The candidate is on the same general topic as the query but contains no information bearing on what the query asks.',
    'The candidate gives background or related facts from which part of an answer could be inferred, without addressing the question itself.',
    'The candidate directly addresses part of what the query asks and leaves a substantive part unanswered.',
    'The candidate states the answer to the query explicitly and completely enough to act on.',
  ],
}

export const RECALL_EVIDENCE_QUESTIONS = {
  answers_query: answersQuery,
  status,
  evidence_value: evidenceValue,
} as const

/**
 * Content cap per candidate. Jev's per-request budget is 32k tokens for state plus the
 * longest question; an uncapped session-dump entry would either blow that or dominate
 * the cost of a search. Truncation is recorded on the state so it shows in the
 * fingerprint and in the log.
 */
export const RECALL_CANDIDATE_MAX_CHARS = 6000

/** The fields of a retrieval result that this module reads. */
export interface RecallCandidate {
  id?: string
  content?: string
  contentType?: string
  timestamp?: string | number | Date
  metadata?: Record<string, unknown> | null
  [k: string]: unknown
}

function isoDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const d = value instanceof Date ? value : new Date(value as string | number)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The state for one (query, candidate) pair.
 *
 * Only what bears on the three judgments goes in. Notably absent, on purpose:
 *  - the candidate's rank and retrieval scores — the judgment must be independent of the
 *    ordering it is later compared against;
 *  - the stored `confidence` — that is `knowledge_confidence`, the author's claim about
 *    the fact, and showing it to the engine would let it leak into `jev_*` signals.
 *
 * Correction metadata IS included: `superseded_context` cannot be judged from wording
 * alone when the supersede chain lives in metadata.
 */
export function buildRecallState(query: string, candidate: RecallCandidate, now: Date = new Date()): DecisionJson {
  const content = typeof candidate.content === 'string' ? candidate.content : ''
  const truncated = content.length > RECALL_CANDIDATE_MAX_CHARS
  const metadata: Record<string, unknown> = candidate.metadata ?? {}
  const updateHistory = metadata.update_history

  // `flag` / `superseded_by` are top-level on graph and MongoDB entries; `supersedes` is
  // metadata on the replacement. Read both places so a backend's projection choice does
  // not decide what the engine is told. Ids are reduced to booleans: an opaque UUID is
  // no evidence, and named by direction so "this entry REPLACES an older one" (which
  // makes it the current one) cannot be misread as "this entry WAS replaced".
  const flag = stringOrNull(candidate.flag) ?? stringOrNull(metadata.flag)
  const supersededBy = stringOrNull(candidate.superseded_by) ?? stringOrNull(metadata.superseded_by)

  return {
    query,
    today: now.toISOString().slice(0, 10),
    candidate: {
      content: truncated ? content.slice(0, RECALL_CANDIDATE_MAX_CHARS) : content,
      content_truncated: truncated,
      content_type: stringOrNull(candidate.contentType),
      stored_at: isoDate(candidate.timestamp),
      subject: stringOrNull(metadata.subject),
      correction_flag: flag,
      replaced_by_later_entry: supersededBy !== null,
      replaces_earlier_entry: stringOrNull(metadata.supersedes) !== null,
      times_edited: Array.isArray(updateHistory) ? updateHistory.length : 0,
    },
  }
}

/**
 * Fingerprint of exactly what the engine was shown (see `stateFingerprint.ts`).
 *
 * `today` is excluded. It is part of the state (the engine needs it to judge
 * "historical") but including it would make the same query over the same entry hash
 * differently every day, which defeats the point of a fingerprint: spotting that two
 * rows judged the same input and disagreed.
 */
export function fingerprintRecallState(state: DecisionJson): string {
  return fingerprintState(state, ['today'])
}
