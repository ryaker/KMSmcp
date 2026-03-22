import { OllamaInference, EntityMention } from '../inference/OllamaInference.js'
import { Neo4jStorage } from '../storage/Neo4jStorage.js'
import { MongoDBStorage } from '../storage/MongoDBStorage.js'

interface CachedCandidates {
  candidates: EntityMention[]
  expiresAt: number
}

export class EntityLinker {
  private candidateCache: CachedCandidates | null = null
  private readonly CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

  constructor(
    private ollama: OllamaInference,
    private neo4j: Neo4jStorage,
    private mongodb: MongoDBStorage
  ) {}

  async enrich(id: string, content: string, sourceSystem: 'mongodb' | 'mem0' | 'neo4j'): Promise<void> {
    const candidates = await this.getCandidates()

    if (candidates.length === 0) {
      console.warn('[EntityLinker] no entity candidates available — skipping enrichment')
      return
    }

    let foundIds = await this.ollama.extractEntityMentions(content, candidates)
    let method = 'ollama'

    if (foundIds.length === 0) {
      foundIds = this.fuzzyMatch(content, candidates)
      method = 'fuzzy'
    }

    if (foundIds.length === 0) {
      return
    }

    // Persist entityRefs back to the source document when the backend supports updates.
    // Mem0 does not expose a metadata-update API, so refs for mem0 records are only
    // written as ABOUT relationships in Neo4j and not reflected in Mem0 metadata.
    if (sourceSystem === 'mongodb') {
      await this.mongodb.update(id, { metadata: { entityRefs: foundIds } })
    }

    await this.neo4j.createAboutRelationships(id, foundIds)

    console.log(`[EntityLinker] ${id}: linked ${foundIds.length} entities via ${method}: [${foundIds.join(', ')}]`)
  }

  private async getCandidates(): Promise<EntityMention[]> {
    const now = Date.now()
    if (this.candidateCache && this.candidateCache.expiresAt > now) {
      return this.candidateCache.candidates
    }

    const raw = await this.neo4j.getEntityCandidates()
    const candidates: EntityMention[] = raw.map(r => ({
      id: r.id,
      name: r.name,
      aliases: r.aliases
    }))

    this.candidateCache = {
      candidates,
      expiresAt: now + this.CACHE_TTL_MS
    }

    return candidates
  }

  private fuzzyMatch(content: string, candidates: EntityMention[]): string[] {
    const lower = content.toLowerCase()
    const matched = new Set<string>()

    for (const candidate of candidates) {
      // Match canonical name
      if (candidate.name.length > 3 && lower.includes(candidate.name.toLowerCase())) {
        matched.add(candidate.id)
        continue
      }

      // Match any alias (maiden names, married names, nicknames, family titles)
      if (candidate.aliases) {
        for (const alias of candidate.aliases) {
          if (alias.length > 3 && lower.includes(alias.toLowerCase())) {
            matched.add(candidate.id)
            break
          }
        }
      }
    }

    return Array.from(matched)
  }

  /**
   * Check if a person name resolves to an existing Neo4j node.
   * Use this before creating any new Person node to prevent duplicates.
   */
  async resolvePersonName(name: string): Promise<string | null> {
    return this.neo4j.resolvePersonId(name)
  }
}
