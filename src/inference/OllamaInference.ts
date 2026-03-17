export interface ClassifyResult {
  targets: Array<'mem0' | 'mongodb' | 'neo4j'>
  contentType: 'episodic' | 'procedural' | 'relational' | 'factual' | 'insight'
  confidence: number
}

export interface EntityMention {
  id: string
  name: string
  aliases?: string[]
}

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
    const timer = setTimeout(() => controller.abort(), 200)

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      })
      const value = response.ok
      this.availableCache = { value, expiresAt: now + 30_000 }
      console.log(`[OllamaInference] availability check: ${value}`)
      return value
    } catch {
      this.availableCache = { value: false, expiresAt: now + 30_000 }
      console.warn('[OllamaInference] availability check failed — Ollama not reachable')
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async classifyStorageTargets(content: string): Promise<ClassifyResult | null> {
    const prompt = `Return JSON only. No explanation. No markdown.
{"targets":["neo4j","mem0"],"contentType":"episodic|procedural|relational|factual|insight","confidence":0.0}

Rules:
- neo4j: ALWAYS include — every fact, memory, or insight creates entities and typed edges in the knowledge graph
- mem0: ALWAYS include — every piece of knowledge needs semantic recall and episodic memory
- mongodb: ADD ONLY when content is procedural (step-by-step), config/schema, debug notes, or technical documentation
- Baseline for ALL content: ["neo4j","mem0"]
- Add mongodb for: procedures, configs, debug logs, technical specs, deployment steps
- confidence: how sure you are (0.0-1.0)

Text: "${content.slice(0, 500)}"`

    const raw = await this.callOllama(prompt, 3000)
    if (raw === null) {
      return null
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ClassifyResult>

      if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
        console.warn('[OllamaInference] classifyStorageTargets: missing or empty targets')
        return null
      }

      const validTargets: Array<'mem0' | 'mongodb' | 'neo4j'> = ['mem0', 'mongodb', 'neo4j']
      const targets = Array.from(new Set(
        parsed.targets.filter((t): t is 'mem0' | 'mongodb' | 'neo4j' =>
          validTargets.includes(t as 'mem0' | 'mongodb' | 'neo4j')
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

    const raw = await this.callOllama(prompt, 4000)
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
