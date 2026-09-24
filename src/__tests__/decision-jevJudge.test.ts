/**
 * JevJudge — the dedup gate's Tier 2 judge on Jev, against a fake DecisionEngine and a
 * fake fallback LLMJudgeService. No network.
 */

import { JEV_JUDGE_FLAG, JevJudge, isJevJudgeEnabled } from '../decision/jevJudge.js'
import { WRITE_DEDUP_NOULS, WRITE_DEDUP_RELATIONS, type WriteDedupNoul, type WriteDedupRelation } from '../decision/writeDedupRelation.js'
import type { LLMJudgeService, LLMRelation } from '../embedding/LLMJudgeService.js'
import type { DecisionEngine, DecisionRequest, DecisionResult } from '../decision/types.js'
import { TokenBucket, setEngineRateLimiterForTests } from '../decision/engineSlot.js'

beforeEach(() => setEngineRateLimiterForTests(new TokenBucket({ ratePerSecond: 1000, burst: 1000, maxQueue: 1000 })))
afterEach(() => setEngineRateLimiterForTests())

const relationAnswers = (
  relation: WriteDedupRelation,
  p: number,
  nouls: Partial<Record<WriteDedupNoul, number>> = {},
  confidence = 0.9
): DecisionResult['answers'] => {
  const rest = (1 - p) / (WRITE_DEDUP_RELATIONS.length - 1)
  return {
    relation: {
      type: 'choice',
      choice: relation,
      confidence,
      probabilities: Object.fromEntries(WRITE_DEDUP_RELATIONS.map(r => [r, r === relation ? p : rest])),
    },
    ...Object.fromEntries(WRITE_DEDUP_NOULS.map(id => [id, { type: 'noul' as const, probability: nouls[id] ?? 0.05 }])),
  }
}

const result = (a: DecisionResult['answers']): DecisionResult => ({
  provider: 'mock',
  model: 'mock-1',
  requestedModel: 'mock-latest',
  answers: a,
  usage: { inputTokens: 300, outputTokens: 10 },
  latencyMs: 80,
  costUsdEstimate: 0.0000126,
  requestId: 'req-judge-1',
})

const mockEngine = (
  respond: (request: DecisionRequest) => DecisionResult['answers'] | Promise<never>
): { engine: DecisionEngine; evaluate: jest.Mock } => {
  const evaluate = jest.fn(async (request: DecisionRequest) => result(await respond(request)))
  const engine: DecisionEngine = { provider: 'mock', requestedModel: 'mock-latest', evaluate }
  return { engine, evaluate }
}

const mockFallback = (relation: LLMRelation = 'unrelated'): { fallback: LLMJudgeService; classify: jest.Mock } => {
  const classify = jest.fn(async () => relation)
  return { fallback: { modelId: 'fallback-model', classify, isAvailable: async () => true }, classify }
}

const ARGS = { newContent: 'The Phoenix rig uses 16 cameras now.', candidateContent: 'The Phoenix rig uses 6 cameras.' }

describe('isJevJudgeEnabled', () => {
  it('is on by default and off only for the string "0"', () => {
    expect(isJevJudgeEnabled({})).toBe(true)
    expect(isJevJudgeEnabled({ [JEV_JUDGE_FLAG]: '1' })).toBe(true)
    expect(isJevJudgeEnabled({ [JEV_JUDGE_FLAG]: 'off' })).toBe(true)
    expect(isJevJudgeEnabled({ [JEV_JUDGE_FLAG]: '0' })).toBe(false)
  })
})

describe('JevJudge.classify — each policy proposal maps to its relation', () => {
  const cases: Array<{ name: string; relation: WriteDedupRelation; p: number; confidence?: number; nouls: Partial<Record<WriteDedupNoul, number>>; expected: LLMRelation }> = [
    {
      name: 'suggest_supersede → supersedes',
      relation: 'supersedes', p: 0.95,
      nouls: { same_subject: 0.9, new_marks_correction: 0.9, claims_conflict: 0.05, candidate_marks_correction: 0.05 },
      expected: 'supersedes',
    },
    {
      name: 'suggest_keep_existing → supersedes-reverse',
      relation: 'supersedes_reverse', p: 0.9,
      nouls: { same_subject: 0.9, candidate_marks_correction: 0.9, claims_conflict: 0.05 },
      expected: 'supersedes-reverse',
    },
    {
      name: 'escalate_contradiction → contradicts',
      relation: 'contradicts', p: 0.9,
      nouls: { same_subject: 0.9, claims_conflict: 0.9, new_marks_correction: 0.05, candidate_marks_correction: 0.05 },
      expected: 'contradicts',
    },
    {
      name: 'suggest_skip_duplicate → duplicate',
      relation: 'duplicate', p: 0.95, confidence: 0.9,
      nouls: { same_subject: 0.9, new_adds_information: 0.1, claims_conflict: 0.1 },
      expected: 'duplicate',
    },
    {
      name: 'store_complement → complement',
      relation: 'complement', p: 0.9,
      nouls: { same_subject: 0.9, claims_conflict: 0.1 },
      expected: 'complement',
    },
    {
      name: 'store_new → unrelated',
      relation: 'unrelated', p: 0.9,
      nouls: { same_subject: 0.1, claims_conflict: 0.1 },
      expected: 'unrelated',
    },
  ]

  it.each(cases)('$name', async ({ relation, p, confidence, nouls, expected }) => {
    const { engine } = mockEngine(() => relationAnswers(relation, p, nouls, confidence))
    const { fallback, classify } = mockFallback()
    const judge = new JevJudge(engine, fallback)

    const got = await judge.classify(ARGS)
    expect(got).toBe(expected)
    expect(classify).not.toHaveBeenCalled()
  })
})

describe('JevJudge.classify — "review" falls back to the relation Choice', () => {
  it('supersedes_reverse becomes supersedes-reverse', async () => {
    // p('supersedes_reverse') clears the threshold but same_subject does not, so the
    // policy cannot commit to suggest_keep_existing and answers 'review'.
    const { engine } = mockEngine(() =>
      relationAnswers('supersedes_reverse', 0.85, { same_subject: 0.5, candidate_marks_correction: 0.9, claims_conflict: 0.1 })
    )
    const { fallback, classify } = mockFallback()
    const judge = new JevJudge(engine, fallback)

    const got = await judge.classify(ARGS)
    expect(got).toBe('supersedes-reverse')
    expect(classify).not.toHaveBeenCalled()
  })
})

describe('JevJudge.classify — caching', () => {
  it('the LRU cache avoids a second engine call for the same pair', async () => {
    const { engine, evaluate } = mockEngine(() => relationAnswers('unrelated', 0.9, { same_subject: 0.1, claims_conflict: 0.05 }))
    const { fallback } = mockFallback()
    const judge = new JevJudge(engine, fallback)

    const first = await judge.classify(ARGS)
    const second = await judge.classify(ARGS)

    expect(first).toBe('unrelated')
    expect(second).toBe('unrelated')
    expect(evaluate).toHaveBeenCalledTimes(1)
  })
})

describe('JevJudge.classify — fallback behavior', () => {
  it('an engine fault falls back to the fallback judge', async () => {
    const { engine } = mockEngine(() => {
      throw new Error('engine unavailable')
    })
    const { fallback, classify } = mockFallback('complement')
    const judge = new JevJudge(engine, fallback)

    const got = await judge.classify(ARGS)
    expect(got).toBe('complement')
    expect(classify).toHaveBeenCalledWith(ARGS)
  })

  it('with no fallback, it throws', async () => {
    const { engine } = mockEngine(() => {
      throw new Error('engine unavailable')
    })
    const judge = new JevJudge(engine, null)

    await expect(judge.classify(ARGS)).rejects.toThrow('engine unavailable')
  })
})
