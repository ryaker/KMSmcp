/**
 * JevJudge — the dedup gate's Tier 2 judge on Jev, with the Gemma judge as fallback.
 *
 * Asks Experiment 2's questions (one relation Choice plus five atomic Nouls about the
 * pair, all in one request — docs: Parallel questions) and lets the existing code policy
 * (writeDedupPolicy) turn the probabilities into a relation. The policy only commits to a
 * relation when the atomic judgments agree; otherwise it answers 'review', and the
 * relation Choice's own pick is used. Any fault falls through to the fallback judge.
 */
import type { DecisionEngine } from './types.js'
import { withEngineSlot } from './engineSlot.js'
import { WRITE_DEDUP_NOULS, WRITE_DEDUP_QUESTIONS, buildWriteDedupState, toTier2Relation, type WriteDedupNoul, type WriteDedupRelation } from './writeDedupRelation.js'
import { proposeWriteDedupAction, type WriteDedupProposal } from './writeDedupPolicy.js'
import { readJudgment } from './writeDedupShadow.js'
import { LRUCache, judgeCacheKey, type LLMJudgeService, type LLMRelation } from '../embedding/LLMJudgeService.js'
import { logger } from '../logger.js'

export const JEV_JUDGE_FLAG = 'KMS_JEV_JUDGE'
export const JEV_JUDGE_TIMEOUT_MS = 2000

/** On unless explicitly disabled with KMS_JEV_JUDGE=0 (a credential is still required). */
export function isJevJudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_JUDGE_FLAG] !== '0'
}

const PROPOSAL_RELATION: Partial<Record<WriteDedupProposal, LLMRelation>> = {
  suggest_supersede: 'supersedes',
  suggest_keep_existing: 'supersedes-reverse',
  escalate_contradiction: 'contradicts',
  suggest_skip_duplicate: 'duplicate',
  store_complement: 'complement',
  store_new: 'unrelated',
}

export class JevJudge implements LLMJudgeService {
  readonly modelId: string
  private readonly cache = new LRUCache<string, LLMRelation>(1000)

  constructor(
    private readonly engine: DecisionEngine,
    private readonly fallback: LLMJudgeService | null,
    private readonly timeoutMs: number = JEV_JUDGE_TIMEOUT_MS
  ) {
    this.modelId = `${engine.requestedModel} (fallback ${fallback?.modelId ?? 'none'})`
  }

  async isAvailable(): Promise<boolean> {
    // The engine exists only when a credential route does; a fault per call falls back.
    return true
  }

  async classify(args: { newContent: string; candidateContent: string }): Promise<LLMRelation> {
    const key = judgeCacheKey(args.newContent, args.candidateContent)
    const cached = this.cache.get(key)
    if (cached) return cached
    try {
      const state = buildWriteDedupState(
        { content: args.newContent },
        { content: args.candidateContent }
      )
      const result = await withEngineSlot(() =>
        this.engine.evaluate({ state, questions: WRITE_DEDUP_QUESTIONS, timeoutMs: this.timeoutMs })
      )
      const jev = readJudgment(result)
      const { proposal } = proposeWriteDedupAction({
        relation: { choice: jev.relation.choice, probabilities: jev.relation.jev_probabilities, confidence: jev.relation.jev_confidence },
        nouls: Object.fromEntries(WRITE_DEDUP_NOULS.map(id => [id, jev.nouls[id].jev_probability])) as Record<WriteDedupNoul, number>,
      })
      const relation = PROPOSAL_RELATION[proposal] ?? (toTier2Relation(jev.relation.choice as WriteDedupRelation) as LLMRelation)
      logger.info(`[JevJudge] ${relation} (proposal=${proposal}, choice=${jev.relation.choice}@${jev.relation.jev_confidence.toFixed(2)}, ${result.latencyMs}ms)`)
      this.cache.set(key, relation)
      return relation
    } catch (error) {
      if (!this.fallback) throw error
      logger.warn(`[JevJudge] falling back to ${this.fallback.modelId}: ${error instanceof Error ? error.message : String(error)}`)
      return this.fallback.classify(args)
    }
  }
}
