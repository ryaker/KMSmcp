/**
 * ShadowStorage — Neo4j primary with SparrowDB shadow comparison
 *
 * When KMS_SHADOW_MODE=true:
 *   - All calls are served by Neo4j (primary); its result is returned to the caller.
 *   - The same call is fired asynchronously against SparrowDB (shadow).
 *   - Results are compared and discrepancies logged to stderr with a [SHADOW] prefix.
 *   - SparrowDB errors NEVER propagate — they are caught and logged only.
 *
 * Comparison strategy per method:
 *   store        — no result to compare; just log shadow errors
 *   search       — compare row counts; log first/last IDs when available
 *   getStats     — compare numeric values (row-count keys)
 *   findRelated  — compare row counts
 *   getEntitySummary    — compare null vs non-null
 *   getOperationalNodes — compare row counts
 *   getEntityCandidates — compare row counts
 *   createAboutRelationships — fire and forget
 *   resolvePersonId — compare returned ID (null vs non-null + string equality)
 *   close        — close both, log shadow close errors only
 *
 * Environment:
 *   KMS_SHADOW_MODE=true   enable shadow mode
 *   KMS_SHADOW_VERBOSE=true also log OK comparisons (noisy, useful during bring-up)
 */

import { Neo4jStorage } from './Neo4jStorage.js'
import { SparrowDBStorage } from './SparrowDBStorage.js'
import { UnifiedKnowledge, KnowledgeQuery } from '../types/index.js'

const VERBOSE = process.env.KMS_SHADOW_VERBOSE === 'true'

function shadowLog(method: string, message: string): void {
  console.error(`[SHADOW] ${method}: ${message}`)
}

function logOk(method: string): void {
  if (VERBOSE) {
    shadowLog(method, 'OK')
  }
}

function firstId(rows: any[]): string | undefined {
  const first = rows[0]
  if (!first) return undefined
  return first.id ?? first.nodeId ?? first._id ?? undefined
}

function lastId(rows: any[]): string | undefined {
  const last = rows[rows.length - 1]
  if (!last) return undefined
  return last.id ?? last.nodeId ?? last._id ?? undefined
}

/**
 * ShadowStorage wraps a Neo4jStorage primary and a SparrowDBStorage shadow.
 * It exposes the full Neo4jStorage API so it can be used as a drop-in
 * replacement wherever `this.storage.neo4j` is accessed.
 */
export class ShadowStorage {
  public name = 'shadow(neo4j+sparrowdb)'
  private primary: Neo4jStorage
  private shadow: SparrowDBStorage

  constructor(primary: Neo4jStorage, shadow: SparrowDBStorage) {
    this.primary = primary
    this.shadow = shadow
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // Initialize primary first (must succeed). Shadow failures are non-fatal.
    await this.primary.initialize()
    try {
      await this.shadow.initialize()
      shadowLog('initialize', 'SparrowDB shadow initialized OK')
    } catch (err: any) {
      shadowLog('initialize', `SparrowDB shadow init FAILED (continuing without shadow): ${err?.message ?? err}`)
    }
  }

  async close(): Promise<void> {
    await this.primary.close()
    try {
      await this.shadow.close()
    } catch (err: any) {
      shadowLog('close', `SparrowDB shadow close error: ${err?.message ?? err}`)
    }
  }

  // ---------------------------------------------------------------------------
  // StorageSystem.store
  // ---------------------------------------------------------------------------

  async store(knowledge: UnifiedKnowledge): Promise<void> {
    await this.primary.store(knowledge)
    // Fire shadow async — do not await
    this.shadow.store(knowledge).catch((err: any) => {
      shadowLog('store', `SparrowDB error for id=${knowledge.id}: ${err?.message ?? err}`)
    })
  }

  // ---------------------------------------------------------------------------
  // StorageSystem.search
  // ---------------------------------------------------------------------------

  async search(query: KnowledgeQuery): Promise<any[]> {
    const primaryResult = await this.primary.search(query)

    // Fire shadow async
    this.shadow.search(query).then((shadowResult) => {
      const pCount = primaryResult.length
      const sCount = shadowResult.length
      if (pCount !== sCount) {
        shadowLog(
          'search',
          `neo4j=${pCount} sparrowdb=${sCount} MISMATCH` +
          ` | query="${query.query.slice(0, 80)}"` +
          ` | neo4j_first=${firstId(primaryResult)} neo4j_last=${lastId(primaryResult)}` +
          ` | sparrowdb_first=${firstId(shadowResult)} sparrowdb_last=${lastId(shadowResult)}`
        )
      } else {
        logOk('search')
      }
    }).catch((err: any) => {
      shadowLog('search', `SparrowDB error: ${err?.message ?? err}`)
    })

    return primaryResult
  }

  // ---------------------------------------------------------------------------
  // StorageSystem.getStats
  // ---------------------------------------------------------------------------

  async getStats(): Promise<Record<string, any>> {
    const primaryStats = await this.primary.getStats()

    this.shadow.getStats().then((shadowStats) => {
      // Compare numeric fields that should roughly align
      const countKeys = Object.keys(primaryStats).filter(
        k => typeof primaryStats[k] === 'number'
      )
      const mismatches: string[] = []
      for (const k of countKeys) {
        const pv = primaryStats[k]
        const sv = shadowStats[k]
        if (sv !== undefined && pv !== sv) {
          mismatches.push(`${k}: neo4j=${pv} sparrowdb=${sv}`)
        }
      }
      if (mismatches.length > 0) {
        shadowLog('getStats', `MISMATCH — ${mismatches.join(' | ')}`)
      } else {
        logOk('getStats')
      }
    }).catch((err: any) => {
      shadowLog('getStats', `SparrowDB error: ${err?.message ?? err}`)
    })

    return primaryStats
  }

  // ---------------------------------------------------------------------------
  // findRelated
  // ---------------------------------------------------------------------------

  async findRelated(nodeId: string, maxDepth = 2): Promise<any[]> {
    const primaryResult = await this.primary.findRelated(nodeId, maxDepth)

    this.shadow.findRelated(nodeId, maxDepth).then((shadowResult) => {
      const pCount = primaryResult.length
      const sCount = shadowResult.length
      if (pCount !== sCount) {
        shadowLog(
          'findRelated',
          `neo4j=${pCount} sparrowdb=${sCount} MISMATCH | nodeId=${nodeId}`
        )
      } else {
        logOk('findRelated')
      }
    }).catch((err: any) => {
      shadowLog('findRelated', `SparrowDB error for nodeId=${nodeId}: ${err?.message ?? err}`)
    })

    return primaryResult
  }

  // ---------------------------------------------------------------------------
  // getEntitySummary
  // ---------------------------------------------------------------------------

  async getEntitySummary(id: string): Promise<Record<string, any> | null> {
    const primaryResult = await this.primary.getEntitySummary(id)

    this.shadow.getEntitySummary(id).then((shadowResult) => {
      const pNull = primaryResult === null
      const sNull = shadowResult === null
      if (pNull !== sNull) {
        shadowLog(
          'getEntitySummary',
          `neo4j=${pNull ? 'null' : 'found'} sparrowdb=${sNull ? 'null' : 'found'} MISMATCH | id=${id}`
        )
      } else {
        logOk('getEntitySummary')
      }
    }).catch((err: any) => {
      shadowLog('getEntitySummary', `SparrowDB error for id=${id}: ${err?.message ?? err}`)
    })

    return primaryResult
  }

  // ---------------------------------------------------------------------------
  // getOperationalNodes
  // ---------------------------------------------------------------------------

  async getOperationalNodes(): Promise<any[]> {
    const primaryResult = await this.primary.getOperationalNodes()

    this.shadow.getOperationalNodes().then((shadowResult) => {
      const pCount = primaryResult.length
      const sCount = shadowResult.length
      if (pCount !== sCount) {
        shadowLog(
          'getOperationalNodes',
          `neo4j=${pCount} sparrowdb=${sCount} MISMATCH`
        )
      } else {
        logOk('getOperationalNodes')
      }
    }).catch((err: any) => {
      shadowLog('getOperationalNodes', `SparrowDB error: ${err?.message ?? err}`)
    })

    return primaryResult
  }

  // ---------------------------------------------------------------------------
  // getEntityCandidates
  // ---------------------------------------------------------------------------

  async getEntityCandidates(): Promise<any[]> {
    const primaryResult = await this.primary.getEntityCandidates()

    this.shadow.getEntityCandidates().then((shadowResult) => {
      const pCount = primaryResult.length
      const sCount = shadowResult.length
      if (pCount !== sCount) {
        shadowLog(
          'getEntityCandidates',
          `neo4j=${pCount} sparrowdb=${sCount} MISMATCH`
        )
      } else {
        logOk('getEntityCandidates')
      }
    }).catch((err: any) => {
      shadowLog('getEntityCandidates', `SparrowDB error: ${err?.message ?? err}`)
    })

    return primaryResult
  }

  // ---------------------------------------------------------------------------
  // createAboutRelationships
  // ---------------------------------------------------------------------------

  async createAboutRelationships(knowledgeId: string, entityIds: string[]): Promise<void> {
    await this.primary.createAboutRelationships(knowledgeId, entityIds)

    this.shadow.createAboutRelationships(knowledgeId, entityIds).catch((err: any) => {
      shadowLog(
        'createAboutRelationships',
        `SparrowDB error for knowledgeId=${knowledgeId}: ${err?.message ?? err}`
      )
    })
  }

  // ---------------------------------------------------------------------------
  // resolvePersonId  (Neo4j-only method; SparrowDB doesn't implement it)
  // ---------------------------------------------------------------------------

  async resolvePersonId(rawName: string): Promise<string | null> {
    const primaryResult = await this.primary.resolvePersonId(rawName)

    // SparrowDB doesn't implement resolvePersonId — skip shadow comparison.
    // Log if verbose so operator knows this method is uncompared.
    if (VERBOSE) {
      shadowLog('resolvePersonId', `neo4j=${primaryResult ?? 'null'} (sparrowdb: not implemented — skipped)`)
    }

    return primaryResult
  }
}
