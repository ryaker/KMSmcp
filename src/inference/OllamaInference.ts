export interface ClassifyResult {
  targets: Array<'mem0' | 'mongodb' | 'graph'>
  contentType: 'episodic' | 'procedural' | 'relational' | 'factual' | 'insight'
  confidence: number
}

export interface EntityMention {
  id: string
  name: string
  aliases?: string[]
}

/**
 * Timeout budgets. These were originally tuned for an Ollama running on loopback,
 * where a reachability probe completes in ~1 ms and a model is always resident.
 * Once Ollama moves to another host on the LAN, every one of them is too tight:
 * a probe costs 100-150 ms, and the FIRST inference after a model is evicted pays
 * a multi-second load. Each is overridable by env var so a slower host does not
 * require a code change.
 */
const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Reachability probe. LAN round-trip measured at 115-133 ms; 200 ms left no margin. */
const AVAILABILITY_TIMEOUT_MS = envMs('OLLAMA_AVAILABILITY_TIMEOUT_MS', 2_000)
/** Storage classification. Cold qwen3:8b measured 5.2 s, warm ~1.7 s; 3 s truncated every cold call. */
const CLASSIFY_TIMEOUT_MS = envMs('OLLAMA_CLASSIFY_TIMEOUT_MS', 8_000)
/** Entity extraction — same cold-load exposure as classification. */
const ENTITY_TIMEOUT_MS = envMs('OLLAMA_ENTITY_TIMEOUT_MS', 8_000)
/**
 * A positive result is stable and worth caching. A negative one must expire quickly:
 * caching it for 30 s meant a single slow probe disabled LLM routing for every write
 * in the following half-minute.
 */
const AVAILABILITY_CACHE_TTL_OK_MS = envMs('OLLAMA_AVAILABILITY_CACHE_OK_MS', 30_000)
const AVAILABILITY_CACHE_TTL_FAIL_MS = envMs('OLLAMA_AVAILABILITY_CACHE_FAIL_MS', 5_000)

export class OllamaInference {
  private availableCache: { value: boolean; expiresAt: number } | null = null

  constructor(
    private baseUrl = 'http://localhost:11434',
    private model = 'qwen3:8b'
  ) {}

  async isAvailable(): Promise<boolean> {
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
      this.availableCache = {
        value,
        expiresAt: now + (value ? AVAILABILITY_CACHE_TTL_OK_MS : AVAILABILITY_CACHE_TTL_FAIL_MS),
      }
      console.log(`[OllamaInference] availability check: ${value}`)
      return value
    } catch {
      this.availableCache = { value: false, expiresAt: now + AVAILABILITY_CACHE_TTL_FAIL_MS }
      console.warn(
        `[OllamaInference] availability check failed — Ollama not reachable at ${this.baseUrl} ` +
        `(timeout ${AVAILABILITY_TIMEOUT_MS}ms)`
      )
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async classifyStorageTargets(content: string): Promise<ClassifyResult | null> {
    const prompt = `Return JSON only. No explanation. No markdown.
{"targets":["graph","mem0"],"contentType":"episodic|procedural|relational|factual|insight","confidence":0.0}

Rules:
- graph: ALWAYS include — every fact, memory, or insight creates entities and typed edges in the graph backend (SparrowDB)
- mem0: ALWAYS include — every piece of knowledge needs semantic recall and episodic memory
- mongodb: ADD ONLY when content is procedural (step-by-step), config/schema, debug notes, or technical documentation
- Baseline for ALL content: ["graph","mem0"]
- Add mongodb for: procedures, configs, debug logs, technical specs, deployment steps
- confidence: how sure you are (0.0-1.0)

Text: "${content.slice(0, 500)}"`

    const raw = await this.callOllama(prompt, CLASSIFY_TIMEOUT_MS)
    if (raw === null) {
      return null
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ClassifyResult>

      if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
        console.warn('[OllamaInference] classifyStorageTargets: missing or empty targets')
        return null
      }

      const validTargets: Array<'mem0' | 'mongodb' | 'graph'> = ['mem0', 'mongodb', 'graph']
      const targets = Array.from(new Set(
        parsed.targets.filter((t): t is 'mem0' | 'mongodb' | 'graph' =>
          validTargets.includes(t as 'mem0' | 'mongodb' | 'graph')
        )
      ))
      if (targets.length === 0) {
        console.warn('[OllamaInference] classifyStorageTargets: no valid target values')
        return null
      }

      const validContentTypes = ['episodic', 'procedural', 'relational', 'factual', 'insight'] as const
      type ContentType = typeof validContentTypes[number]
      const contentType: ContentType = validContentTypes.includes(parsed.contentType as ContentType)
        ? (parsed.contentType as ContentType)
        : 'factual'

      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0

      if (confidence < 0.5) {
        console.warn(`[OllamaInference] classifyStorageTargets: low confidence ${confidence}, returning null`)
        return null
      }

      const result: ClassifyResult = { targets, contentType, confidence }
      console.log(`[OllamaInference] classifyStorageTargets: targets=${targets.join(',')}, contentType=${contentType}, confidence=${confidence}`)
      return result
    } catch (err) {
      console.warn('[OllamaInference] classifyStorageTargets: JSON parse failed', err)
      return null
    }
  }

  async extractEntityMentions(content: string, candidates: EntityMention[]): Promise<string[]> {
    if (candidates.length === 0) {
      return []
    }

    const available = await this.isAvailable()
    if (!available) {
      return []
    }

    const prompt = `Return a JSON array of IDs only. No explanation. Return [] if nothing matches.

From the Candidates list below, return only the IDs of entities that are mentioned or clearly implied in the Text.

Candidates: ${JSON.stringify(candidates.slice(0, 30))}

Text: "${content.slice(0, 600)}"`

    const raw = await this.callOllama(prompt, ENTITY_TIMEOUT_MS)
    if (raw === null) {
      return []
    }

    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        console.warn('[OllamaInference] extractEntityMentions: response is not an array')
        return []
      }

      const candidateIds = new Set(candidates.map(c => c.id))
      const filtered = Array.from(new Set(
        (parsed as unknown[])
          .filter((item): item is string => typeof item === 'string' && candidateIds.has(item))
      ))

      console.log(`[OllamaInference] extractEntityMentions: found ${filtered.length} of ${candidates.length} candidates`)
      return filtered
    } catch (err) {
      console.warn('[OllamaInference] extractEntityMentions: JSON parse failed', err)
      return []
    }
  }

  private async callOllama(prompt: string, timeoutMs: number): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt, stream: false, think: false }),
        signal: controller.signal,
      })

      if (!response.ok) {
        console.warn(`[OllamaInference] callOllama: non-200 status ${response.status}`)
        return null
      }

      const body = await response.json() as { response?: string }
      if (typeof body.response !== 'string') {
        console.warn('[OllamaInference] callOllama: response field missing or not a string')
        return null
      }

      return body.response.trim()
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError'
      console.warn(`[OllamaInference] callOllama: ${isAbort ? 'timeout' : 'network error'}`, isAbort ? '' : err)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
