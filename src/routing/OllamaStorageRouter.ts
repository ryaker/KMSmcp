import { OllamaInference } from '../inference/OllamaInference.js'
import { IntelligentStorageRouter } from './IntelligentStorageRouter.js'
import { UnifiedKnowledge } from '../types/index.js'

export interface RoutingDecision {
  targets: Array<'mem0' | 'mongodb' | 'neo4j'>
  contentType: string
  source: 'llm' | 'regex'
  confidence: number
}

export class OllamaStorageRouter {
  constructor(
    private ollama: OllamaInference,
    private fallback: IntelligentStorageRouter
  ) {}

  async getStorageTargets(
    content: string,
    metadata?: Record<string, any>
  ): Promise<RoutingDecision> {
    const available = await this.ollama.isAvailable()

    if (available) {
      const result = await this.ollama.classifyStorageTargets(content)

      if (result !== null && result.confidence >= 0.6) {
        const { targets, contentType, confidence } = result
        console.log(
          `[OllamaStorageRouter] llm(confidence=${confidence.toFixed(2)}) → [${targets.join(', ')}]`
        )
        return { targets, contentType, source: 'llm', confidence }
      }
    }

    // Resolve contentType from both locations: top-level and inferred
    const resolvedContentType = metadata?.contentType ?? metadata?.inferred?.contentType ?? 'fact'

    // Fallback: build a minimal UnifiedKnowledge from content + metadata
    const knowledge: Partial<UnifiedKnowledge> = {
      content,
      contentType: resolvedContentType,
      ...(metadata?.source ? { source: metadata.source } : {}),
      ...(metadata?.userId ? { userId: metadata.userId } : {}),
    }

    const decision = this.fallback.determineStorage(knowledge)

    // Combine primary + secondary into a deduplicated targets array
    const targetSet = new Set<'mem0' | 'mongodb' | 'neo4j'>([decision.primary])
    if (decision.secondary) {
      for (const s of decision.secondary) {
        targetSet.add(s)
      }
    }
    const targets = Array.from(targetSet)
    const confidence = 0.5

    console.log(
      `[OllamaStorageRouter] regex(confidence=${confidence.toFixed(2)}) → [${targets.join(', ')}]`
    )

    return {
      targets,
      contentType: resolvedContentType,
      source: 'regex',
      confidence,
    }
  }
}
