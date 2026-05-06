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
import { logger } from '../logger.js';
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_VERSION = 'v1'; // bump when pre-processing/model changes
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_TIMEOUT_MS = 5_000;
const AVAILABILITY_CACHE_TTL_MS = 30_000;
/**
 * Determines whether an error from a fetch/embed call is worth retrying.
 *
 * Checks structured error codes first (portable across Node.js versions and
 * fetch implementations). Falls back to message-string matching only as a last
 * resort for environments where `code` isn't surfaced (e.g. browser fetch or
 * third-party polyfills).
 */
function isRetryableEmbedError(err) {
    if (err instanceof Error) {
        // AbortError = our own timeout signal fired
        if (err.name === 'AbortError')
            return true;
        // Structured network error codes — check both the top-level error and the
        // wrapped cause (Node 18+ wraps the original network error in err.cause).
        const code = err.code
            ?? err.cause?.code;
        if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
            return true;
        }
        // Fallback: message-string heuristics for environments that don't surface
        // err.code (e.g. undici's "fetch failed" wrapper, older Node versions).
        if (/fetch failed|ECONNREFUSED|timeout|ETIMEDOUT|ECONNRESET/i.test(err.message)) {
            return true;
        }
    }
    return false;
}
/**
 * Ollama-backed implementation. Calls POST /api/embeddings and returns the
 * resulting vector. Single retry on transient failure (timeout / network
 * error); throws thereafter.
 */
export class OllamaEmbeddingService {
    embedderId;
    dimensions;
    baseUrl;
    model;
    timeoutMs;
    availableCache = null;
    constructor(config = {}) {
        this.baseUrl = config.baseUrl
            || process.env.OLLAMA_BASE_URL
            || DEFAULT_BASE_URL;
        this.model = config.model || DEFAULT_MODEL;
        const version = config.version || DEFAULT_VERSION;
        this.embedderId = `${this.model}:${version}`;
        this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
        this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    async isAvailable() {
        const now = Date.now();
        if (this.availableCache && this.availableCache.expiresAt > now) {
            return this.availableCache.value;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 500);
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`, {
                signal: controller.signal,
            });
            const value = response.ok;
            this.availableCache = { value, expiresAt: now + AVAILABILITY_CACHE_TTL_MS };
            return value;
        }
        catch {
            this.availableCache = { value: false, expiresAt: now + AVAILABILITY_CACHE_TTL_MS };
            return false;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async embed(text) {
        if (typeof text !== 'string' || text.length === 0) {
            throw new TypeError('OllamaEmbeddingService.embed: text must be a non-empty string');
        }
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return await this._embedOnce(text);
            }
            catch (err) {
                lastError = err;
                // Only retry on timeout / network errors. Not on dimension mismatch
                // or other shape-level failures — those won't fix themselves.
                if (!isRetryableEmbedError(err))
                    break;
                if (attempt === 0) {
                    logger.warn(`[OllamaEmbeddingService] embed retry after error: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(`OllamaEmbeddingService.embed failed: ${String(lastError)}`);
    }
    async _embedOnce(text) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(`${this.baseUrl}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, prompt: text }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`OllamaEmbeddingService: HTTP ${response.status} ${response.statusText}`);
            }
            const body = await response.json();
            if (!Array.isArray(body.embedding)) {
                throw new Error('OllamaEmbeddingService: missing or non-array embedding field in response');
            }
            // Validate dimension. nomic-embed-text returns 768; if Ollama is
            // configured with a different model under the same name, surface the
            // mismatch immediately rather than corrupting the index.
            if (body.embedding.length !== this.dimensions) {
                throw new Error(`OllamaEmbeddingService: embedding dim mismatch — expected ${this.dimensions}, got ${body.embedding.length}`);
            }
            const out = new Float32Array(this.dimensions);
            for (let i = 0; i < this.dimensions; i++) {
                const v = body.embedding[i];
                if (typeof v !== 'number' || Number.isNaN(v)) {
                    throw new Error(`OllamaEmbeddingService: non-numeric value at embedding[${i}]`);
                }
                out[i] = v;
            }
            return out;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
