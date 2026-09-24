/**
 * JevDecisionEngine — DecisionEngine backed by TypeSafe's System One API (model: Jev).
 *
 * The only file in KMSmcp that imports `@typesafe-ai/sdk`. It translates the
 * provider-neutral question shapes in `./types.ts` to the SDK's and back, and nothing
 * else: no retrieval knowledge, no policy, no thresholds.
 */

import { TypeSafeClient } from '@typesafe-ai/sdk'
import type { Questions } from '@typesafe-ai/sdk'
import { logger } from '../logger.js'
import { createOneCliFetch } from './onecli.js'
import type {
  DecisionAnswer,
  DecisionEngine,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from './types.js'

export const JEV_PROVIDER = 'typesafe'

/**
 * Env var naming the model to request. The default is a pinned version, not `jev-latest`:
 * aliases move to new models (https://docs.typesafe.ai/models.md, "Aliases"), and every
 * threshold and weight in the shadow policies is tuned against the answers of one version.
 * Move the pin deliberately, and re-score the labelled pool when you do.
 */
export const JEV_MODEL_ENV = 'KMS_JEV_MODEL'
export const JEV_DEFAULT_MODEL = 'jev-1.13.0'

/**
 * USD per million tokens, from https://docs.typesafe.ai/models (read 2026-09-19):
 * Jev 1.13 is $0.042 / Mtok input, output tokens free. Overridable because an alias can
 * move to a differently-priced model without a change on this side; the log records the
 * price that was applied alongside every estimate so a stale default is detectable.
 */
export const JEV_PRICE_INPUT_ENV = 'KMS_JEV_PRICE_INPUT_PER_MTOK'
export const JEV_PRICE_OUTPUT_ENV = 'KMS_JEV_PRICE_OUTPUT_PER_MTOK'
export const JEV_DEFAULT_PRICE_INPUT_PER_MTOK = 0.042
export const JEV_DEFAULT_PRICE_OUTPUT_PER_MTOK = 0

/**
 * Per-attempt timeout. The SDK default is 10 s; a recall-path judgment that takes that
 * long has already failed at its job, and in shadow mode a slow call only costs a log
 * row, so fail fast.
 */
export const JEV_DEFAULT_TIMEOUT_MS = 5000

/** The slice of `TypeSafeClient` this engine uses — what a test double must provide. */
export interface SystemOneClient {
  systemOne(
    request: { state: unknown; questions: Questions; model?: string },
    options?: { timeout?: number; signal?: AbortSignal }
  ): { withResponse(): Promise<{ data: SystemOneData; requestId: string | undefined }> }
}

interface SystemOneData {
  model: string
  answers: Record<string, unknown>
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface JevPricing {
  inputPerMtok: number
  outputPerMtok: number
}

export interface JevDecisionEngineOptions {
  client: SystemOneClient
  model?: string
  timeoutMs?: number
  /** `null` disables cost estimation (the result then carries `costUsdEstimate: null`). */
  pricing?: JevPricing | null
}

function toSdkQuestion(q: DecisionQuestion): Questions[string] {
  switch (q.type) {
    case 'noul':
      return { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }
    case 'choice':
      return { type: 'choice', instructions: q.instructions, criteria: { ...q.criteria } }
    case 'score': {
      if (q.criteria.length < 2) throw new Error('score question needs at least two levels')
      const [first, second, ...rest] = q.criteria
      return { type: 'score', instructions: q.instructions, criteria: [first, second, ...rest] }
    }
  }
}

function isProbability(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
}

function readDistribution(raw: unknown, questionId: string): Record<string, number> {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`jev: answer "${questionId}" has no probabilities`)
  }
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProbability(value)) throw new Error(`jev: answer "${questionId}" probability "${key}" is not in [0, 1]`)
    out[key] = value
  }
  return out
}

/**
 * Typed output guarantees the interface, not that the wire honoured it. Validate the
 * shape against the question that was asked: a judgment that arrives as the wrong kind,
 * or with a probability outside [0, 1], is a provider fault and must surface as one
 * rather than flow into a log row as if it were a measurement.
 */
function fromSdkAnswer(questionId: string, question: DecisionQuestion, raw: unknown): DecisionAnswer {
  const a = raw as Record<string, unknown> | undefined
  if (!a || a.type !== question.type) {
    throw new Error(`jev: answer "${questionId}" is ${String(a?.type)}, expected ${question.type}`)
  }
  switch (question.type) {
    case 'noul':
      if (!isProbability(a.noul)) throw new Error(`jev: noul "${questionId}" is not in [0, 1]`)
      return { type: 'noul', probability: a.noul }
    case 'choice':
      if (typeof a.choice !== 'string' || !isProbability(a.confidence)) {
        throw new Error(`jev: choice "${questionId}" is malformed`)
      }
      return {
        type: 'choice',
        choice: a.choice,
        probabilities: readDistribution(a.probabilities, questionId),
        confidence: a.confidence,
      }
    case 'score':
      if (typeof a.score !== 'number' || !Number.isFinite(a.score) || !isProbability(a.confidence)) {
        throw new Error(`jev: score "${questionId}" is malformed`)
      }
      return {
        type: 'score',
        score: a.score,
        probabilities: readDistribution(a.probabilities, questionId),
        confidence: a.confidence,
      }
  }
}

export class JevDecisionEngine implements DecisionEngine {
  readonly provider = JEV_PROVIDER
  readonly requestedModel: string
  private readonly client: SystemOneClient
  private readonly timeoutMs: number
  private readonly pricing: JevPricing | null

  constructor(options: JevDecisionEngineOptions) {
    this.client = options.client
    this.requestedModel = options.model ?? JEV_DEFAULT_MODEL
    this.timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS
    this.pricing = options.pricing === undefined
      ? { inputPerMtok: JEV_DEFAULT_PRICE_INPUT_PER_MTOK, outputPerMtok: JEV_DEFAULT_PRICE_OUTPUT_PER_MTOK }
      : options.pricing
  }

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const questionIds = Object.keys(request.questions)
    if (questionIds.length === 0) throw new Error('jev: evaluate() needs at least one question')

    const questions: Questions = {}
    for (const id of questionIds) questions[id] = toSdkQuestion(request.questions[id])

    const started = Date.now()
    const { data, requestId } = await this.client
      .systemOne(
        { state: request.state, questions, model: this.requestedModel },
        { timeout: request.timeoutMs ?? this.timeoutMs, ...(request.signal ? { signal: request.signal } : {}) }
      )
      .withResponse()
    const latencyMs = Date.now() - started

    const answers: Record<string, DecisionAnswer> = {}
    for (const id of questionIds) answers[id] = fromSdkAnswer(id, request.questions[id], data.answers?.[id])

    const usage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    }
    const costUsdEstimate = this.pricing
      ? (usage.inputTokens * this.pricing.inputPerMtok + usage.outputTokens * this.pricing.outputPerMtok) / 1_000_000
      : null

    return {
      provider: this.provider,
      model: data.model,
      requestedModel: this.requestedModel,
      answers,
      usage,
      latencyMs,
      costUsdEstimate,
      ...(requestId ? { requestId } : {}),
    }
  }
}

function readPrice(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(`decision: ignoring ${name}="${raw}" (not a non-negative number); using ${fallback}`)
    return fallback
  }
  return parsed
}

export function jevPricingFromEnv(env: NodeJS.ProcessEnv = process.env): JevPricing {
  return {
    inputPerMtok: readPrice(env, JEV_PRICE_INPUT_ENV, JEV_DEFAULT_PRICE_INPUT_PER_MTOK),
    outputPerMtok: readPrice(env, JEV_PRICE_OUTPUT_ENV, JEV_DEFAULT_PRICE_OUTPUT_PER_MTOK),
  }
}

/**
 * The SDK's default logger is `console`, whose `info`/`debug` write to STDOUT — which on
 * the MCP stdio transport is the protocol channel. Route every level to the stderr-only
 * KMS logger so raising TYPESAFE_LOG_LEVEL can never corrupt a session.
 */
export const stderrSdkLogger = {
  debug: (message: string, ...args: unknown[]) => logger.debug(message, ...args),
  info: (message: string, ...args: unknown[]) => logger.info(message, ...args),
  warn: (message: string, ...args: unknown[]) => logger.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => logger.error(message, ...args),
}

/** Placeholder the SDK requires; the OneCLI gateway replaces the header it produces. */
const ONECLI_MANAGED_API_KEY = 'ONECLI_MANAGED'

/**
 * Build the Jev engine from the environment, or return null when no credential route
 * exists. Two routes, in this order:
 *
 *  1. OneCLI gateway (`ONECLI_TOKEN` + `ONECLI_GATEWAY`) — the intended one. Requests go
 *     through the local credential gateway, which injects the real TypeSafe key for
 *     `*.typesafe.ai`. This process never holds the key: the SDK is given a placeholder
 *     and the gateway overwrites the Authorization header in flight.
 *  2. `TYPESAFE_API_KEY` directly — for environments without a gateway.
 *
 * Null rather than a throw: the caller is a shadow path that must degrade to "no
 * evaluation" when Jev is unreachable, exactly as the dedup gate's Tier 2 does
 * when Ollama does not answer.
 */
export function createJevDecisionEngineFromEnv(env: NodeJS.ProcessEnv = process.env): JevDecisionEngine | null {
  const viaGateway = createOneCliFetch(env)
  const directKey = env.TYPESAFE_API_KEY?.trim()
  if (!viaGateway && !directKey) return null

  const client = new TypeSafeClient({
    apiKey: viaGateway ? ONECLI_MANAGED_API_KEY : directKey,
    ...(viaGateway ? { fetch: viaGateway } : {}),
    logger: stderrSdkLogger,
    // One retry, not the SDK's two: a shadow evaluation that needs three attempts is
    // better recorded as a failure than as a 15 s latency sample.
    retry: { maxRetries: 1 },
  })
  return new JevDecisionEngine({
    client: client as unknown as SystemOneClient,
    model: env[JEV_MODEL_ENV]?.trim() || JEV_DEFAULT_MODEL,
    pricing: jevPricingFromEnv(env),
  })
}
