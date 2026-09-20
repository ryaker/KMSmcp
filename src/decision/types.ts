/**
 * DecisionEngine — the semantic-decision tier between deterministic KMS machinery and
 * generative reasoning.
 *
 * Why an interface rather than a TypeSafe import at the call site
 * ---------------------------------------------------------------
 * The architecture brief (docs/architecture/jev-system-one-kms-proposal-2026-09-18.md) is
 * explicit: "Do not scatter TypeSafe/Jev calls through KMSmcp." Everything outside
 * `src/decision/` talks to this interface only, so the provider can be swapped (or
 * mocked) without touching retrieval, and so a second provider's answers land in the
 * same log shape and can be compared against the first.
 *
 * The three question kinds mirror what a bounded semantic judgment can be — a yes/no
 * probability, one of a closed set, a position on an ordered rubric. They are deliberately
 * NOT the TypeSafe SDK's types re-exported: a provider that returns the same three
 * shapes through a different API must be able to implement this without depending on it.
 *
 * Signal namespaces (do not conflate)
 * -----------------------------------
 * Everything a DecisionEngine returns is a *judgment about one request*. It is not a
 * property of the stored knowledge and not a retrieval score:
 *
 *   vector_similarity     embedding proximity                (retrieval arm)
 *   retrieval_relevance   usefulness for the current query   (ranker)
 *   knowledge_confidence  the author's confidence in a fact  (stored on the entry)
 *   jev_probability /
 *   jev_confidence        the engine's answer distribution   (THIS module)
 *   policy_decision       what deterministic code did with it
 *
 * Nothing in this module writes to `confidence`, `_score`, `_relevance` or
 * `_vectorSimilarity`, and nothing downstream may copy an engine value into them.
 */

/** Text or JSON handed to the engine — the question text, a rubric entry, or the state. */
export type DecisionJson =
  | string
  | number
  | boolean
  | null
  | DecisionJson[]
  | { [key: string]: DecisionJson }

/** Does a condition hold? Answered with a probability of yes. */
export interface NoulDecisionQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}

/** One of a closed set. Keys are the option ids code branches on. */
export interface ChoiceDecisionQuestion {
  type: 'choice'
  instructions: string
  /** option id → what that option means. */
  criteria: Record<string, string>
}

/** A position on an ordered rubric, lowest level first. */
export interface ScoreDecisionQuestion {
  type: 'score'
  instructions: string
  /** Ordered level descriptions, index 0 = lowest. At least two. */
  criteria: readonly string[]
}

export type DecisionQuestion =
  | NoulDecisionQuestion
  | ChoiceDecisionQuestion
  | ScoreDecisionQuestion

export interface NoulDecisionAnswer {
  type: 'noul'
  /** P(yes) in [0, 1]. Near 0.5 means "as likely yes as no", not "medium". */
  probability: number
}

export interface ChoiceDecisionAnswer {
  type: 'choice'
  /** The highest-probability option id. */
  choice: string
  /** Every option id → probability. Sums to 1. */
  probabilities: Record<string, number>
  /** Concentration of `probabilities`, in [0, 1]. Not correctness, not permission to act. */
  confidence: number
}

export interface ScoreDecisionAnswer {
  type: 'score'
  /** Probability-weighted level index; may fall between levels. */
  score: number
  /** Level index (as a string key) → probability. Sums to 1. */
  probabilities: Record<string, number>
  /** Concentration of `probabilities`, in [0, 1]. */
  confidence: number
}

export type DecisionAnswer =
  | NoulDecisionAnswer
  | ChoiceDecisionAnswer
  | ScoreDecisionAnswer

export interface DecisionRequest {
  /** Everything the engine may look at. Questions cannot see each other's answers. */
  state: DecisionJson
  /** Question id → question. Ids are for code; they are not shown to the model. */
  questions: Record<string, DecisionQuestion>
  /** Per-attempt timeout. The engine's default applies when omitted. */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface DecisionUsage {
  inputTokens: number
  outputTokens: number
}

export interface DecisionResult {
  /** Stable provider id, e.g. `typesafe`. */
  provider: string
  /**
   * The model that actually answered, as the provider reported it. When a request is
   * sent to an alias (`jev-latest`) this is whatever the provider echoed back — record
   * it as-is rather than substituting the alias that was asked for.
   */
  model: string
  /** The model id the request asked for (may be an alias). */
  requestedModel: string
  answers: Record<string, DecisionAnswer>
  usage: DecisionUsage
  /** Wall-clock for this one evaluate() call, retries included. */
  latencyMs: number
  /**
   * Estimated cost in USD from `usage` and the configured per-token price, or null when
   * no price is configured. An estimate from a price table, never a billed amount.
   */
  costUsdEstimate: number | null
  /** Provider request id when one was returned — the handle for a support query. */
  requestId?: string
}

export interface DecisionEngine {
  /** Stable provider id, e.g. `typesafe`. */
  readonly provider: string
  /** The model id requests are sent to (may be an alias). */
  readonly requestedModel: string
  /**
   * Answer every question over one state. Rejects on transport/provider failure — the
   * caller decides what a failure means; an engine never invents an answer.
   */
  evaluate(request: DecisionRequest): Promise<DecisionResult>
}
