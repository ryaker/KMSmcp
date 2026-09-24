/**
 * JevStorageRouter — storage-target routing on Jev, against a fake DecisionEngine and a
 * fake fallback StorageTargetRouter. No network.
 */

import {
  JEV_ROUTER_FLAG,
  JEV_ROUTER_MAX_CHARS,
  JEV_ROUTER_STRUCTURED_MIN,
  JEV_ROUTER_TIMEOUT_MS,
  JevStorageRouter,
  ROUTER_QUESTIONS,
  isJevRouterEnabled,
} from '../decision/jevStorageRouter.js'
import type { RoutingDecision, StorageTargetRouter } from '../routing/OllamaStorageRouter.js'
import type { DecisionEngine, DecisionRequest, DecisionResult } from '../decision/types.js'
import { TokenBucket, setEngineRateLimiterForTests } from '../decision/engineSlot.js'

// A generous bucket so tests never wait on the process-wide rate limiter.
beforeEach(() => setEngineRateLimiterForTests(new TokenBucket({ ratePerSecond: 1000, burst: 1000, maxQueue: 1000 })))
afterEach(() => setEngineRateLimiterForTests())

const answers = (over: Partial<{ pStructured: number; kind: string; kindConfidence: number; pMem0: number }> = {}): DecisionResult['answers'] => {
  const { pStructured = 0.2, kind = 'episodic', kindConfidence = 0.8, pMem0 = 0.5 } = over
  return {
    needs_structured_store: { type: 'noul', probability: pStructured },
    content_type: {
      type: 'choice',
      choice: kind,
      confidence: kindConfidence,
      probabilities: { [kind]: kindConfidence, other: 1 - kindConfidence },
    },
    needs_semantic_recall: { type: 'noul', probability: pMem0 },
  }
}

const result = (a: DecisionResult['answers']): DecisionResult => ({
  provider: 'mock',
  model: 'mock-1',
  requestedModel: 'mock-latest',
  answers: a,
  usage: { inputTokens: 40, outputTokens: 6 },
  latencyMs: 120,
  costUsdEstimate: 0.0000017,
  requestId: 'req-router-1',
})

const mockEngine = (
  respond: (request: DecisionRequest) => DecisionResult['answers'] | Promise<never>
): { engine: DecisionEngine; evaluate: jest.Mock } => {
  const evaluate = jest.fn(async (request: DecisionRequest) => result(await respond(request)))
  const engine: DecisionEngine = { provider: 'mock', requestedModel: 'mock-latest', evaluate }
  return { engine, evaluate }
}

const FALLBACK_DECISION: RoutingDecision = {
  targets: ['graph', 'mem0'],
  contentType: 'fact',
  source: 'regex',
  confidence: 0.5,
}

const mockFallback = (decision: RoutingDecision = FALLBACK_DECISION): { fallback: StorageTargetRouter; getStorageTargets: jest.Mock } => {
  const getStorageTargets = jest.fn(async () => decision)
  return { fallback: { getStorageTargets }, getStorageTargets }
}

describe('isJevRouterEnabled', () => {
  it('is on by default and off only for the string "0"', () => {
    expect(isJevRouterEnabled({})).toBe(true)
    expect(isJevRouterEnabled({ [JEV_ROUTER_FLAG]: '1' })).toBe(true)
    expect(isJevRouterEnabled({ [JEV_ROUTER_FLAG]: 'false' })).toBe(true)
    expect(isJevRouterEnabled({ [JEV_ROUTER_FLAG]: '' })).toBe(true)
    expect(isJevRouterEnabled({ [JEV_ROUTER_FLAG]: '0' })).toBe(false)
  })
})

describe('JevStorageRouter.getStorageTargets — happy path', () => {
  it('adds mongodb when p_structured is above the threshold', async () => {
    const { engine } = mockEngine(() => answers({ pStructured: JEV_ROUTER_STRUCTURED_MIN + 0.01 }))
    const { fallback } = mockFallback()
    const router = new JevStorageRouter(engine, fallback)

    const decision = await router.getStorageTargets('some content')
    expect(decision.targets).toEqual(expect.arrayContaining(['graph', 'mem0', 'mongodb']))
  })

  it('does not add mongodb at or below the threshold', async () => {
    const { engine } = mockEngine(() => answers({ pStructured: JEV_ROUTER_STRUCTURED_MIN }))
    const { fallback } = mockFallback()
    const router = new JevStorageRouter(engine, fallback)

    const atThreshold = await router.getStorageTargets('some content')
    expect(atThreshold.targets).not.toContain('mongodb')

    const { engine: belowEngine } = mockEngine(() => answers({ pStructured: JEV_ROUTER_STRUCTURED_MIN - 0.3 }))
    const belowRouter = new JevStorageRouter(belowEngine, fallback)
    const belowThreshold = await belowRouter.getStorageTargets('some content')
    expect(belowThreshold.targets).not.toContain('mongodb')
  })

  it('always includes graph and mem0, with or without mongodb', async () => {
    for (const pStructured of [0, JEV_ROUTER_STRUCTURED_MIN, 1]) {
      const { engine } = mockEngine(() => answers({ pStructured }))
      const { fallback } = mockFallback()
      const router = new JevStorageRouter(engine, fallback)
      const decision = await router.getStorageTargets('some content')
      expect(decision.targets).toEqual(expect.arrayContaining(['graph', 'mem0']))
    }
  })

  it('reports source "jev" and the content_type Choice confidence', async () => {
    const { engine } = mockEngine(() => answers({ kind: 'procedural', kindConfidence: 0.73 }))
    const { fallback } = mockFallback()
    const router = new JevStorageRouter(engine, fallback)

    const decision = await router.getStorageTargets('some content')
    expect(decision.source).toBe('jev')
    expect(decision.contentType).toBe('procedural')
    expect(decision.confidence).toBe(0.73)
  })

  it('returns pMem0Needed from needs_semantic_recall without it affecting targets', async () => {
    for (const pMem0 of [0, 0.42, 1]) {
      const { engine } = mockEngine(() => answers({ pMem0 }))
      const { fallback } = mockFallback()
      const router = new JevStorageRouter(engine, fallback)
      const decision = await router.getStorageTargets('some content')
      expect(decision.pMem0Needed).toBe(pMem0)
      // Measurement only — mem0 is always present and the set of targets is otherwise
      // identical across every value of pMem0Needed.
      expect(decision.targets).toEqual(expect.arrayContaining(['graph', 'mem0']))
      expect(decision.targets).not.toContain('needs_semantic_recall')
    }
  })

  it('asks needs_semantic_recall in the same request as the other questions', async () => {
    const { engine, evaluate } = mockEngine(() => answers())
    const { fallback } = mockFallback()
    const router = new JevStorageRouter(engine, fallback)

    await router.getStorageTargets('some content')
    const request = evaluate.mock.calls[0][0] as DecisionRequest
    expect(Object.keys(request.questions)).toEqual(
      expect.arrayContaining(['needs_structured_store', 'content_type', 'needs_semantic_recall'])
    )
    expect(request.questions).toBe(ROUTER_QUESTIONS)
  })
})

describe('JevStorageRouter — targets are unchanged regardless of needs_semantic_recall', () => {
  it.each([0, 0.1, 0.5, 0.9, 1])('pMem0=%s does not change targets for a fixed p_structured', async pMem0 => {
    const { engine: lowEngine } = mockEngine(() => answers({ pStructured: 0.1, pMem0 }))
    const { fallback: lowFallback } = mockFallback()
    const low = await new JevStorageRouter(lowEngine, lowFallback).getStorageTargets('x')
    expect(low.targets.slice().sort()).toEqual(['graph', 'mem0'])

    const { engine: highEngine } = mockEngine(() => answers({ pStructured: 0.9, pMem0 }))
    const { fallback: highFallback } = mockFallback()
    const high = await new JevStorageRouter(highEngine, highFallback).getStorageTargets('x')
    expect(high.targets.slice().sort()).toEqual(['graph', 'mem0', 'mongodb'])
  })
})

describe('JevStorageRouter — content cap', () => {
  it('caps content at JEV_ROUTER_MAX_CHARS before sending it to the engine', async () => {
    const long = 'y'.repeat(JEV_ROUTER_MAX_CHARS + 500)
    const { engine, evaluate } = mockEngine(() => answers())
    const { fallback } = mockFallback()
    const router = new JevStorageRouter(engine, fallback)

    await router.getStorageTargets(long)
    const request = evaluate.mock.calls[0][0] as DecisionRequest
    expect((request.state as { text: string }).text).toHaveLength(JEV_ROUTER_MAX_CHARS)
  })
})

describe('JevStorageRouter — timeoutMs', () => {
  it('passes the default timeout through to the engine when none is given', async () => {
    const { engine, evaluate } = mockEngine(() => answers())
    const { fallback } = mockFallback()
    await new JevStorageRouter(engine, fallback).getStorageTargets('x')
    expect(evaluate.mock.calls[0][0].timeoutMs).toBe(JEV_ROUTER_TIMEOUT_MS)
  })

  it('passes a custom timeoutMs through to the engine', async () => {
    const { engine, evaluate } = mockEngine(() => answers())
    const { fallback } = mockFallback()
    await new JevStorageRouter(engine, fallback, 750).getStorageTargets('x')
    expect(evaluate.mock.calls[0][0].timeoutMs).toBe(750)
  })
})

describe('JevStorageRouter — falls back to the Ollama router', () => {
  it('on an engine throw', async () => {
    const { engine } = mockEngine(() => {
      throw new Error('engine unavailable')
    })
    const { fallback, getStorageTargets } = mockFallback()
    const decision = await new JevStorageRouter(engine, fallback).getStorageTargets('some content', { userId: 'richard_yaker' })

    expect(decision).toEqual(FALLBACK_DECISION)
    expect(getStorageTargets).toHaveBeenCalledWith('some content', { userId: 'richard_yaker' })
  })

  it('on answers of the wrong kind', async () => {
    const { engine } = mockEngine(() => ({
      // content_type answered as a noul instead of a choice.
      needs_structured_store: { type: 'noul', probability: 0.1 },
      content_type: { type: 'noul', probability: 0.9 } as unknown as DecisionResult['answers'][string],
      needs_semantic_recall: { type: 'noul', probability: 0.5 },
    }))
    const { fallback, getStorageTargets } = mockFallback()
    const decision = await new JevStorageRouter(engine, fallback).getStorageTargets('some content')

    expect(decision).toEqual(FALLBACK_DECISION)
    expect(getStorageTargets).toHaveBeenCalledTimes(1)
  })

  it('on a timeout', async () => {
    const { engine } = mockEngine(async () => {
      throw new Error('decision engine request timed out after 1500ms')
    })
    const { fallback, getStorageTargets } = mockFallback()
    const decision = await new JevStorageRouter(engine, fallback).getStorageTargets('some content')

    expect(decision).toEqual(FALLBACK_DECISION)
    expect(getStorageTargets).toHaveBeenCalledTimes(1)
  })
})
