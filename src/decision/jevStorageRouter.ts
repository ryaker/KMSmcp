/**
 * JevStorageRouter — picks a write's storage targets with Jev, falling back to the
 * Gemma router (OllamaStorageRouter, and its regex fallback) on any fault.
 *
 * graph + mem0 are written for every entry, so the only open decision is whether the
 * entry also goes to MongoDB. That is one yes/no judgment — a Noul — instead of asking
 * a generative model to emit JSON with a self-reported "confidence" (5–19 s per write on
 * rym1). Jev returns calibrated probabilities in a few hundred ms (docs: System One).
 *
 * content_type is asked in the same request (questions are evaluated in parallel and in
 * isolation — docs: Primitives, Parallel questions), so it costs no extra time; its
 * Choice confidence is the decision's reported confidence (docs: Confidence).
 */
import type { DecisionEngine, DecisionQuestion } from './types.js'
import { withEngineSlot } from './engineSlot.js'
import type { RoutingDecision, StorageTargetRouter } from '../routing/OllamaStorageRouter.js'
import { logger } from '../logger.js'

export const JEV_ROUTER_FLAG = 'KMS_JEV_ROUTER'
/** One request; measured p95 for a single Jev call is ~300 ms. The rest is headroom. */
export const JEV_ROUTER_TIMEOUT_MS = 1500
/** Plenty for a routing judgment, well inside the 32k state budget (docs: Models). */
export const JEV_ROUTER_MAX_CHARS = 4000
/** P(structured) above this adds MongoDB. Starting point, not fitted. */
export const JEV_ROUTER_STRUCTURED_MIN = 0.5

/** On unless explicitly disabled with KMS_JEV_ROUTER=0 (a credential is still required). */
export function isJevRouterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_ROUTER_FLAG] !== '0'
}

export const CONTENT_TYPES = ['episodic', 'procedural', 'relational', 'factual', 'insight'] as const

export const ROUTER_QUESTIONS: Record<string, DecisionQuestion> = {
  needs_structured_store: {
    type: 'noul',
    instructions:
      'Is `text` technical reference material that someone will look up later: step-by-step procedures, commands, configuration or schema details, debug or error logs, technical specifications, or deployment steps?',
    criteria: {
      true: 'The text gives procedures, commands, configuration values, schemas, logs, specifications or deployment steps that a person would consult to do or check something technical.',
      false: 'The text records an event, decision, preference, opinion, relationship, lesson or plain fact, without procedures, configuration, logs or specifications to consult.',
    },
  },
  content_type: {
    type: 'choice',
    instructions: 'What kind of knowledge does `text` mainly record?',
    criteria: {
      episodic: 'Something that happened at a particular time: an event, a conversation, a session, or a decision being made.',
      procedural: 'How to do something: steps, commands, a fix or workaround to apply.',
      relational: 'How people, projects or things relate to each other: who works with whom, what depends on or belongs to what.',
      factual: 'A fact about how something is: a setting, a value, a configuration, or the state of a system or the world.',
      insight: 'A lesson, principle, realization or preference drawn from experience.',
    },
  },
  /**
   * SHADOW ONLY (docs: 3C). Measurement, not a routing input — mem0 stays always-on
   * regardless of the answer here, because nobody has decided to route by it yet. Logged
   * and returned as `pMem0Needed` so the shadow data exists before that decision is made.
   */
  needs_semantic_recall: {
    type: 'noul',
    instructions:
      'Is `text` something a future assistant should recall by meaning in a later, unrelated conversation: a preference, a decision and the reason for it, a lesson learned, or a fact about a person or a project? As opposed to transient chatter, raw tool output, logs, or a status update with no lasting value.',
    criteria: {
      true: 'The text states a preference, a decision (with or without its reason), a lesson, or a fact about a person or a project — something worth bringing up again later, on its own, without the conversation that produced it.',
      false: 'The text is transient chatter, tool or command output, a log line, a status or progress update, or other noise that has no value once this conversation ends.',
    },
  },
}

export class JevStorageRouter implements StorageTargetRouter {
  constructor(
    private readonly engine: DecisionEngine,
    private readonly fallback: StorageTargetRouter,
    private readonly timeoutMs: number = JEV_ROUTER_TIMEOUT_MS
  ) {}

  async getStorageTargets(content: string, metadata?: Record<string, any>): Promise<RoutingDecision> {
    try {
      const result = await withEngineSlot(() =>
        this.engine.evaluate({
          state: { text: content.slice(0, JEV_ROUTER_MAX_CHARS) },
          questions: ROUTER_QUESTIONS,
          timeoutMs: this.timeoutMs,
        })
      )
      const structured = result.answers.needs_structured_store
      const kind = result.answers.content_type
      const semanticRecall = result.answers.needs_semantic_recall
      if (structured?.type !== 'noul' || kind?.type !== 'choice' || semanticRecall?.type !== 'noul') {
        throw new Error('engine returned answers of the wrong kind for the routing questions')
      }
      // mem0 is always a target (see class doc) — needs_semantic_recall is measurement
      // only and must never gate it, even once this reaches a decision on routing.
      const targets: RoutingDecision['targets'] = ['graph', 'mem0']
      if (structured.probability > JEV_ROUTER_STRUCTURED_MIN) targets.push('mongodb')
      logger.info(
        `[JevStorageRouter] jev(p_structured=${structured.probability.toFixed(2)}, type=${kind.choice}@${kind.confidence.toFixed(2)}, p_mem0=${semanticRecall.probability.toFixed(2)}, ${result.latencyMs}ms) → [${targets.join(', ')}]`
      )
      return { targets, contentType: kind.choice, source: 'jev', confidence: kind.confidence, pMem0Needed: semanticRecall.probability }
    } catch (error) {
      logger.warn(`[JevStorageRouter] falling back to the Ollama router: ${error instanceof Error ? error.message : String(error)}`)
      return this.fallback.getStorageTargets(content, metadata)
    }
  }
}
