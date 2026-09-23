/**
 * OllamaJudge — concrete LLMJudgeService backed by a local Ollama model.
 * Used by the dedup gate's Tier 2 (DG-T2-A) to classify the relationship
 * between a new write and a candidate that fell into the borderline
 * confirm-band.
 *
 * Replaces the Anthropic Haiku judge: the M1 mini runs Ollama locally, so the
 * classification costs nothing per call and no cloud credential is required.
 * The prompt, the six-relation enum, the LRU cache and the lenient parser are
 * unchanged from the Haiku implementation — only the transport moved.
 *
 * Design choices:
 *   - LRU cache (1000 entries) on the (newContent, candidateContent) pair, so a
 *     single MCP session that hits the gate repeatedly with the same content
 *     pays for one inference, not one per candidate.
 *   - Timeout via AbortController. On timeout we throw — UnifiedStoreTool
 *     catches the throw and leaves that candidate's `llm_relation` null rather
 *     than failing the whole gate response.
 *   - `isAvailable()` is a real reachability probe against /api/tags, not a
 *     config check. The previous implementation could only ask "is a key set",
 *     which is meaningless here — Ollama may be configured and still down, and
 *     it is on another host on the LAN.
 *   - `think: false` — the default model (qwen3:8b) is a reasoning model, and
 *     its thinking block would otherwise be the only thing a 12-token budget
 *     has room for.
 */

import {
  LLMJudgeService,
  LLMRelation,
  LRUCache,
  judgeCacheKey,
  parseLLMRelation,
} from './LLMJudgeService.js'
import { logger } from '../logger.js'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const DEFAULT_MODEL = 'qwen3:8b'
const DEFAULT_CACHE_SIZE = 1000

/**
 * Timeout budgets. Same reasoning as OllamaInference.ts: these were sized for an
 * Ollama on loopback, where a probe costs ~1 ms and the model is always
 * resident. On the LAN a probe costs 100-150 ms, and the FIRST inference after
 * the model is evicted pays a multi-second load. A 5 s budget truncated every
 * cold call, so the default is deliberately larger than the Haiku judge's.
 */
const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Classification. Cold load measured at 5.2 s on this stack; 8 s covers it. */
const JUDGE_TIMEOUT_MS = envMs('OLLAMA_JUDGE_TIMEOUT_MS', 8_000)
/** Reachability probe. Shares the var with OllamaInference so one setting governs both. */
const AVAILABILITY_TIMEOUT_MS = envMs('OLLAMA_AVAILABILITY_TIMEOUT_MS', 2_000)
/**
 * A positive probe is stable and worth caching. A negative one must expire
 * quickly: caching it for 30 s meant a single slow probe disabled the judge for
 * every candidate in the following half-minute.
 */
const AVAILABILITY_CACHE_TTL_OK_MS = envMs('OLLAMA_AVAILABILITY_CACHE_OK_MS', 30_000)
const AVAILABILITY_CACHE_TTL_FAIL_MS = envMs('OLLAMA_AVAILABILITY_CACHE_FAIL_MS', 5_000)

/**
 * The classifier prompt — tight and forced to a single-word response. The
 * candidate is fed first and the new content second because the relations are
 * asymmetric (supersedes vs supersedes-reverse) and the model needs a
 * consistent ordering convention.
 */
const SYSTEM_PROMPT = `You are a strict classifier. Compare two pieces of knowledge content and respond with EXACTLY ONE WORD chosen from this enum:

- duplicate: same fact expressed differently, no new information in NEW
- supersedes: NEW corrects/replaces/updates EXISTING (newer, more accurate)
- supersedes-reverse: EXISTING corrects/replaces NEW (NEW is the outdated one)
- complement: both true, different facets/aspects of related topic, keep both
- contradicts: factually opposed; only one can be true
- unrelated: different facts that happen to share keywords

Respond with ONLY the single enum word. No punctuation, no explanation, no formatting.`

export interface OllamaJudgeConfig {
  /** Ollama base URL. Defaults to env OLLAMA_BASE_URL, then localhost:11434. */
  baseUrl?: string
  /** Model id (defaults to env OLLAMA_MODEL, then qwen3:8b). */
  model?: string
  /** Per-call timeout in ms (default: env OLLAMA_JUDGE_TIMEOUT_MS, then 8000). */
  timeoutMs?: number
  /** Max LRU cache entries (default: 1000). */
  cacheSize?: number
  /**
   * Optional fetch override — primarily for tests so a fake transport can be
   * injected without monkey-patching globals. Production callers leave this
   * unset.
   */
  fetchImpl?: typeof fetch
}

export class OllamaJudge implements LLMJudgeService {
  public readonly modelId: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly cache: LRUCache<string, LLMRelation>
  private readonly fetchImpl: typeof fetch
  private availableCache: { value: boolean; expiresAt: number } | null = null

  constructor(config: OllamaJudgeConfig = {}) {
    this.baseUrl = config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL
    this.modelId = config.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL
    this.timeoutMs = config.timeoutMs ?? JUDGE_TIMEOUT_MS
    this.cache = new LRUCache<string, LLMRelation>(config.cacheSize ?? DEFAULT_CACHE_SIZE)
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now()
    if (this.availableCache && this.availableCache.expiresAt > now) {
      return this.availableCache.value
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS)

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      })
      const value = response.ok
      // TTL starts when the probe COMPLETES, not when it started — otherwise a
      // probe that burns the full timeout gets a TTL shortened by exactly that.
      this.availableCache = {
        value,
        expiresAt: Date.now() + (value ? AVAILABILITY_CACHE_TTL_OK_MS : AVAILABILITY_CACHE_TTL_FAIL_MS),
      }
      return value
    } catch {
      this.availableCache = {
        value: false,
        expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_FAIL_MS,
      }
      logger.debug(
        `[OllamaJudge] probe failed — Ollama not reachable at ${this.baseUrl} ` +
        `(timeout ${AVAILABILITY_TIMEOUT_MS}ms)`
      )
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async classify(args: {
    newContent: string
    candidateContent: string
  }): Promise<LLMRelation> {
    const { newContent, candidateContent } = args

    // Defensive: empty inputs never hit the model. 'unrelated' is the safe
    // answer — it triggers no urgency in the gate response.
    if (!newContent || !candidateContent) {
      return 'unrelated'
    }

    const key = judgeCacheKey(newContent, candidateContent)
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      logger.debug(`[OllamaJudge] cache HIT for pair (${key.slice(0, 8)}…)`)
      return cached
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      // Format: candidate first, new content second — matches the prompt's
      // EXISTING/NEW labels so the asymmetric relations resolve correctly.
      const prompt =
        `${SYSTEM_PROMPT}\n\nEXISTING:\n${candidateContent}\n\n---\n\nNEW:\n${newContent}\n\nRelation:`

      const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId,
          prompt,
          stream: false,
          think: false,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`[OllamaJudge] non-200 status ${response.status}`)
      }

      const body = await response.json() as { response?: string }
      if (typeof body.response !== 'string') {
        throw new Error('[OllamaJudge] response field missing or not a string')
      }

      const relation = parseLLMRelation(body.response)
      this.cache.set(key, relation)
      logger.debug(
        `[OllamaJudge] classified pair (${key.slice(0, 8)}…) → ${relation} ` +
        `(raw="${body.response.trim().slice(0, 40)}")`
      )
      return relation
    } finally {
      clearTimeout(timer)
    }
  }
}
