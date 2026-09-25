/**
 * EmbeddingService — text → fixed-dimension Float32Array vector.
 *
 * Used by the dedup gate (DG-T1-A and DG-T1-B) to embed knowledge content
 * at write time so a later semantic-similarity check can flag near-duplicates.
 *
 * Architectural decisions (DG-INV-1):
 *   - Embedder: nomic-embed-text @ 768d via Ollama (local, no cloud dependency).
 *   - The `embedderId` (model:version) is persisted on every embedding so
 *     future embedder swaps can invalidate stale vectors (spec §9 — embedding
 *     drift mitigation).
 *   - Calls degrade gracefully when Ollama is unreachable: store path continues,
 *     just without an embedding. A backfill job can re-embed later.
 */
import { logger } from '../logger.js'
import { DEFAULT_OLLAMA_BASE_URL } from '../inference/OllamaInference.js'
import {
  CircuitBreaker,
  type CircuitState,
  readCircuitCooldownMsFromEnv,
  readCircuitThresholdFromEnv,
} from './circuitBreaker.js'

/**
 * Transient metadata keys for the embedding-handoff pattern (PR #69).
 *
 * UnifiedStoreTool clones the knowledge object before the graph fan-out and
 * splices the freshly-computed vector + embedderId into metadata under these
 * keys. SparrowDBStorage.store() plucks them off and feeds them into a single
 * MERGE-with-all-props-inline executeWithParams call — the only Cypher
 * pattern SparrowDB 0.1.22 honours for HNSW population (see channel msg #202
 * for the SET-silent-failure repro).
 *
 * Both the producer (UnifiedStoreTool) and consumer (SparrowDBStorage) MUST
 * import these — duplicating the literal strings would silently break the
 * handoff if one side renamed and the other didn't. The double-underscore
 * prefix marks them internal/transient; SparrowDBStorage strips them before
 * the sidecar JSON write so they never persist.
 */
export const PENDING_EMBEDDING_KEY = '__pending_embedding'
export const PENDING_EMBEDDER_ID_KEY = '__pending_embedder_id'

/**
 * Thrown by `embed()` (and consulted internally by `isAvailable()`) when the
 * embedder's circuit breaker is open — i.e. enough consecutive failures were
 * seen recently that we fast-fail instead of waiting out another timeout.
 * Distinguishable from a transport/dim-mismatch error so callers/tests can
 * tell "we didn't even try" apart from "we tried and it failed".
 */
export class EmbedderCircuitOpenError extends Error {
  constructor(public readonly embedderId: string) {
    super(`OllamaEmbeddingService: circuit open for ${embedderId} — skipping embed attempt (cooling down)`)
    this.name = 'EmbedderCircuitOpenError'
  }
}

/** A function that turns a string into a fixed-dim vector. */
export interface EmbeddingService {
  /**
   * Stable identifier for the embedder + version. MUST change whenever the
   * underlying model or pre-processing changes — old embeddings can then be
   * detected and re-computed (spec §9).
   * Format: "<model>:<version>" e.g. "nomic-embed-text:v1"
   */
  readonly embedderId: string

  /** Vector dimensionality this service produces. */
  readonly dimensions: number

  /**
   * Embed a single text string. Throws on transport / model failure — the
   * caller is responsible for catching and degrading gracefully (the dedup
   * gate ticket DG-T1-A explicitly does NOT fail unified_store on embed
   * failure). May throw `EmbedderCircuitOpenError` immediately, with no
   * network call, when the implementation's circuit breaker is open —
   * callers should treat it exactly like any other embed failure.
   */
  embed(text: string): Promise<Float32Array>

  /**
   * Quick liveness probe. Used by callers (e.g. UnifiedStoreTool) to decide
   * whether to attempt embed on the hot path or skip and let backfill handle
   * it. Cached internally (~30s) so callers can poll cheaply.
   */
  isAvailable(): Promise<boolean>
}

// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = DEFAULT_OLLAMA_BASE_URL
const DEFAULT_MODEL = 'nomic-embed-text'
const DEFAULT_VERSION = 'v1'  // bump when pre-processing/model changes
const DEFAULT_DIMENSIONS = 768
const DEFAULT_TIMEOUT_MS = 5_000
/**
 * Reachability probe budget. Was hardcoded to 500 ms inline — 10x stricter than
 * DEFAULT_TIMEOUT_MS above, which every real operation uses. That is fine against a
 * loopback Ollama but fails against one on the LAN, where the round-trip alone is
 * 115-133 ms and DNS can add several hundred more.
 */
const AVAILABILITY_TIMEOUT_MS = (() => {
  const raw = process.env.OLLAMA_AVAILABILITY_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2_000
})()
/**
 * Cache a success for a while, but expire a failure fast. A single slow probe used to
 * disable embedding for a full 30 s.
 */
const AVAILABILITY_CACHE_TTL_MS = 30_000
const AVAILABILITY_CACHE_TTL_FAIL_MS = 5_000

export interface OllamaEmbeddingServiceConfig {
  /** Ollama base URL (defaults to env OLLAMA_BASE_URL, then DEFAULT_OLLAMA_BASE_URL — rym1). */
  baseUrl?: string
  /** Model name passed to `/api/embeddings` (default: nomic-embed-text). */
  model?: string
  /** Version suffix that becomes part of `embedderId` (default: v1). */
  version?: string
  /** Expected vector dimensionality (default: 768 for nomic-embed-text). */
  dimensions?: number
  /** Per-request timeout in ms (default: 5000). */
  timeoutMs?: number
  /**
   * Consecutive embed failures (timeout / transport / 5xx) before the circuit
   * breaker opens (default: env KMS_EMBED_CIRCUIT_THRESHOLD, else 3).
   */
  circuitThreshold?: number
  /**
   * How long the breaker stays open before allowing a single half-open probe,
   * in ms (default: env KMS_EMBED_CIRCUIT_COOLDOWN_MS, else 60000).
   */
  circuitCooldownMs?: number
  /** Clock injection for the circuit breaker (tests only; default Date.now). */
  clock?: () => number
}

/**
 * Determines whether an error from a fetch/embed call is worth retrying.
 *
 * Checks structured error codes first (portable across Node.js versions and
 * fetch implementations). Falls back to message-string matching only as a last
 * resort for environments where `code` isn't surfaced (e.g. browser fetch or
 * third-party polyfills).
 */
function isRetryableEmbedError(err: unknown): boolean {
  if (err instanceof Error) {
    // AbortError = our own timeout signal fired
    if (err.name === 'AbortError') return true

    // Structured network error codes — check both the top-level error and the
    // wrapped cause (Node 18+ wraps the original network error in err.cause).
    const code = (err as NodeJS.ErrnoException).code
      ?? ((err as any).cause as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
      return true
    }

    // Fallback: message-string heuristics for environments that don't surface
    // err.code (e.g. undici's "fetch failed" wrapper, older Node versions).
    if (/fetch failed|ECONNREFUSED|timeout|ETIMEDOUT|ECONNRESET/i.test(err.message)) {
      return true
    }
  }
  return false
}

/**
 * Decides whether a failed embed() call should count against the circuit
 * breaker. Timeouts and network/transport errors always count (same set as
 * `isRetryableEmbedError`); an HTTP 5xx also counts even though we don't
 * retry it inline. A 4xx, dimension mismatch, malformed body, or non-finite
 * value does NOT count — those indicate a reachable-but-misbehaving/mismatched
 * endpoint, not an outage, so they must not trip an outage breaker.
 */
function isCircuitBreakerFailure(err: unknown): boolean {
  if (isRetryableEmbedError(err)) return true
  if (err instanceof Error && /OllamaEmbeddingService: HTTP 5\d\d/.test(err.message)) return true
  return false
}

/**
 * Ollama-backed implementation. Calls POST /api/embeddings and returns the
 * resulting vector. Single retry on transient failure (timeout / network
 * error); throws thereafter.
 */
export class OllamaEmbeddingService implements EmbeddingService {
  public readonly embedderId: string
  public readonly dimensions: number
  private readonly baseUrl: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly breaker: CircuitBreaker
  private availableCache: { value: boolean; expiresAt: number } | null = null

  constructor(config: OllamaEmbeddingServiceConfig = {}) {
    this.baseUrl = config.baseUrl
      || process.env.OLLAMA_BASE_URL
      || DEFAULT_BASE_URL
    this.model = config.model || DEFAULT_MODEL
    const version = config.version || DEFAULT_VERSION
    this.embedderId = `${this.model}:${version}`
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitThreshold ?? readCircuitThresholdFromEnv(),
      cooldownMs: config.circuitCooldownMs ?? readCircuitCooldownMsFromEnv(),
      clock: config.clock,
      name: `embed:${this.embedderId}`,
    })
  }

  /** Current circuit breaker state — exposed for health/analytics reporting. */
  getCircuitBreakerState(): CircuitState {
    return this.breaker.getState()
  }

  async isAvailable(): Promise<boolean> {
    // Fast-fail: the breaker being open is stronger evidence than a stale
    // success cached from before the outage started. Checked BEFORE the
    // availability cache and with no network call either way.
    if (this.breaker.isBlocking()) return false

    const now = Date.now()
    if (this.availableCache && this.availableCache.expiresAt > now) {
      return this.availableCache.value
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS)

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      })
      const value = response.ok
      // TTL starts when the probe COMPLETES, not when it started — otherwise a probe
      // that consumes its full timeout gets a correspondingly shortened TTL.
      this.availableCache = {
        value,
        expiresAt: Date.now() + (value ? AVAILABILITY_CACHE_TTL_MS : AVAILABILITY_CACHE_TTL_FAIL_MS),
      }
      return value
    } catch {
      this.availableCache = { value: false, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_FAIL_MS }
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('OllamaEmbeddingService.embed: text must be a non-empty string')
    }

    // Fast-fail: skip straight past the network entirely when the breaker is
    // open, or — once the cooldown has elapsed — admit exactly this call as
    // the single half-open probe. `canProceed()` MUST be paired with exactly
    // one onSuccess()/onFailure() below, however this resolves.
    if (!this.breaker.canProceed()) {
      throw new EmbedderCircuitOpenError(this.embedderId)
    }

    let lastError: unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const vec = await this._embedOnce(text)
        this.breaker.onSuccess()
        return vec
      } catch (err) {
        lastError = err
        // Only retry on timeout / network errors. Not on dimension mismatch
        // or other shape-level failures — those won't fix themselves.
        if (!isRetryableEmbedError(err)) break
        if (attempt === 0) {
          logger.warn(`[OllamaEmbeddingService] embed retry after error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // The breaker tracks outage signal (timeout/transport/5xx), not every
    // failure mode. A dim-mismatch or malformed body means Ollama answered —
    // that's evidence of reachability, so it resolves the breaker call as a
    // success (and, in particular, releases a half-open probe) rather than
    // leaving it stuck waiting for a report that will never distinguish it
    // from an outage.
    if (isCircuitBreakerFailure(lastError)) {
      this.breaker.onFailure()
    } else {
      this.breaker.onSuccess()
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`OllamaEmbeddingService.embed failed: ${String(lastError)}`)
  }

  private async _embedOnce(text: string): Promise<Float32Array> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`OllamaEmbeddingService: HTTP ${response.status} ${response.statusText}`)
      }

      const body = await response.json() as { embedding?: unknown }
      if (!Array.isArray(body.embedding)) {
        throw new Error('OllamaEmbeddingService: missing or non-array embedding field in response')
      }

      // Validate dimension. nomic-embed-text returns 768; if Ollama is
      // configured with a different model under the same name, surface the
      // mismatch immediately rather than corrupting the index.
      if (body.embedding.length !== this.dimensions) {
        throw new Error(
          `OllamaEmbeddingService: embedding dim mismatch — expected ${this.dimensions}, got ${body.embedding.length}`
        )
      }

      const out = new Float32Array(this.dimensions)
      for (let i = 0; i < this.dimensions; i++) {
        const v = body.embedding[i]
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new Error(`OllamaEmbeddingService: non-finite value at embedding[${i}]`)
        }
        out[i] = v
      }
      return out
    } finally {
      clearTimeout(timer)
    }
  }
}
