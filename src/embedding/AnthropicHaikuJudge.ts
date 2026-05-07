/**
 * AnthropicHaikuJudge — concrete LLMJudgeService backed by Claude Haiku 4.5
 * via the Anthropic Messages API. Used by the dedup gate's Tier 2 (DG-T2-A,
 * issue #49) to classify the relationship between a new write and a candidate
 * that fell into the borderline confirm-band.
 *
 * Why Haiku 4.5:
 *   - Cheapest production-grade Anthropic model (~10× cheaper than Sonnet)
 *   - Fast enough that the 5 s timeout is conservative — typical p50 is
 *     well under a second for short classifications.
 *   - Sufficient reasoning capacity for the 6-relation enum we need.
 *
 * Design choices:
 *   - LRU cache (1000 entries) on (newContent, candidateContent) pair so a
 *     single MCP session that hits the gate repeatedly with the same content
 *     pays zero extra cost beyond the first call.
 *   - 5 s AbortController per call. On timeout we throw — the
 *     UnifiedStoreTool integration treats the throw as "leave llm_relation
 *     null" rather than failing the whole gate response.
 *   - Single-word forced response with explicit instruction to choose from
 *     the 6-relation enum. Lenient parser falls back to 'unrelated' if the
 *     response can't be parsed (safest — won't trigger any UI urgency).
 */

import Anthropic from '@anthropic-ai/sdk'
import {
  LLMJudgeService,
  LLMRelation,
  LRUCache,
  judgeCacheKey,
  parseLLMRelation,
} from './LLMJudgeService.js'
import { logger } from '../logger.js'

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_SIZE = 1000
const DEFAULT_MAX_TOKENS = 12  // single-word response — 12 tokens is plenty
const AVAILABILITY_CACHE_TTL_MS = 30_000

// The classifier prompt — tight and forced to a single-word response. We feed
// the candidate first and the new content second because the relations are
// asymmetric (supersedes vs supersedes-reverse) and the model needs a
// consistent ordering convention.
const SYSTEM_PROMPT = `You are a strict classifier. Compare two pieces of knowledge content and respond with EXACTLY ONE WORD chosen from this enum:

- duplicate: same fact expressed differently, no new information in NEW
- supersedes: NEW corrects/replaces/updates EXISTING (newer, more accurate)
- supersedes-reverse: EXISTING corrects/replaces NEW (NEW is the outdated one)
- complement: both true, different facets/aspects of related topic, keep both
- contradicts: factually opposed; only one can be true
- unrelated: different facts that happen to share keywords

Respond with ONLY the single enum word. No punctuation, no explanation, no formatting.`

export interface AnthropicHaikuJudgeConfig {
  /** Anthropic API key. Defaults to env ANTHROPIC_API_KEY. */
  apiKey?: string
  /** Model id (defaults to claude-haiku-4-5-20251001). */
  model?: string
  /** Per-call timeout in ms (default: 5000). */
  timeoutMs?: number
  /** Max LRU cache entries (default: 1000). */
  cacheSize?: number
  /**
   * Optional override of the underlying SDK client — primarily for tests so we
   * can inject a fake without monkey-patching node_modules. Production callers
   * should leave this unset.
   */
  client?: Pick<Anthropic, 'messages'>
}

export class AnthropicHaikuJudge implements LLMJudgeService {
  public readonly modelId: string
  private readonly client: Pick<Anthropic, 'messages'>
  private readonly timeoutMs: number
  private readonly cache: LRUCache<string, LLMRelation>
  private readonly hasApiKey: boolean
  private availableCache: { value: boolean; expiresAt: number } | null = null

  constructor(config: AnthropicHaikuJudgeConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? ''
    this.hasApiKey = apiKey.length > 0
    this.modelId = config.model ?? DEFAULT_MODEL
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cache = new LRUCache<string, LLMRelation>(config.cacheSize ?? DEFAULT_CACHE_SIZE)

    // Test-injected client wins. Otherwise build the real SDK client even if
    // the API key is empty — `isAvailable()` will short-circuit before any
    // request goes out.
    this.client = config.client
      ?? new Anthropic({ apiKey: apiKey || 'missing-key-will-fail-fast' })
  }

  async isAvailable(): Promise<boolean> {
    // No API key → definitively unavailable; don't waste a 30s cache slot.
    if (!this.hasApiKey) return false

    // Cached probe: we can't ping the Anthropic API for "alive?" cheaply
    // (every endpoint counts against quota), so we use the api-key-presence
    // signal as the liveness indicator. If a real network failure happens
    // mid-classify, the caller already handles the throw → null.
    const now = Date.now()
    if (this.availableCache && this.availableCache.expiresAt > now) {
      return this.availableCache.value
    }
    this.availableCache = { value: true, expiresAt: now + AVAILABILITY_CACHE_TTL_MS }
    return true
  }

  async classify(args: {
    newContent: string
    candidateContent: string
  }): Promise<LLMRelation> {
    const { newContent, candidateContent } = args

    // Defensive: empty inputs never hit the API. Treat as 'unrelated' so the
    // dedup gate response still ships a structurally valid candidate.
    if (!newContent || !candidateContent) {
      return 'unrelated'
    }

    // Cache hit — free win, saves $.
    const key = judgeCacheKey(newContent, candidateContent)
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      logger.debug(`[AnthropicHaikuJudge] cache HIT for pair (${key.slice(0, 8)}…)`)
      return cached
    }

    // Hard 5s timeout. AbortController plumbed through the SDK's signal arg.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      // Format: candidate first, new content second — matches the prompt's
      // EXISTING/NEW labels so the asymmetric relations resolve correctly.
      const userMessage =
        `EXISTING:\n${candidateContent}\n\n---\n\nNEW:\n${newContent}\n\nRelation:`

      const response = await this.client.messages.create(
        {
          model: this.modelId,
          max_tokens: DEFAULT_MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: controller.signal as any }
      )

      // Pull the first text block. The SDK can return tool_use / image blocks
      // for richer responses, but for our classification prompt we only ever
      // get text back.
      const textBlock = (response.content || []).find(
        (b: any) => b.type === 'text'
      ) as { type: 'text'; text: string } | undefined

      const raw = textBlock?.text ?? ''
      const relation = parseLLMRelation(raw)

      this.cache.set(key, relation)
      logger.debug(
        `[AnthropicHaikuJudge] classified pair (${key.slice(0, 8)}…) → ${relation} (raw="${raw.slice(0, 40)}")`
      )
      return relation
    } finally {
      clearTimeout(timer)
    }
  }
}
