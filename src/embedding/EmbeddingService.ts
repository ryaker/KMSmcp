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
   * failure).
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

const DEFAULT_BASE_URL = 'http://localhost:11434'
const DEFAULT_MODEL = 'nomic-embed-text'
const DEFAULT_VERSION = 'v1'  // bump when pre-processing/model changes
const DEFAULT_DIMENSIONS = 768
const DEFAULT_TIMEOUT_MS = 5_000
const AVAILABILITY_CACHE_TTL_MS = 30_000

export interface OllamaEmbeddingServiceConfig {
  /** Ollama base URL (defaults to env OLLAMA_BASE_URL or http://localhost:11434). */
  baseUrl?: string
  /** Model name passed to `/api/embeddings` (default: nomic-embed-text). */
  model?: string
  /** Version suffix that becomes part of `embedderId` (default: v1). */
  version?: string
  /** Expected vector dimensionality (default: 768 for nomic-embed-text). */
  dimensions?: number
  /** Per-request timeout in ms (default: 5000). */
  timeoutMs?: number
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
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now()
    if (this.availableCache && this.availableCache.expiresAt > now) {
      return this.availableCache.value
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 500)

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      })
      const value = response.ok
      this.availableCache = { value, expiresAt: now + AVAILABILITY_CACHE_TTL_MS }
      return value
    } catch {
      this.availableCache = { value: false, expiresAt: now + AVAILABILITY_CACHE_TTL_MS }
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('OllamaEmbeddingService.embed: text must be a non-empty string')
    }

    let lastError: unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this._embedOnce(text)
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
