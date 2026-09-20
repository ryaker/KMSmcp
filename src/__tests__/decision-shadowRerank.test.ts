/**
 * runShadowRerank() against a mocked DecisionEngine — what gets asked, what gets logged,
 * and what happens when the engine misbehaves.
 */

import {
  JEV_SHADOW_TOPK_DEFAULT,
  JEV_SHADOW_TOPK_MAX,
  isJevShadowRerankEnabled,
  jevShadowAction,
  jevShadowTopK,
  runShadowRerank,
} from '../decision/shadowRerank.js'
import {
  EVIDENCE_VALUE_LEVELS,
  RECALL_CANDIDATE_MAX_CHARS,
  RECALL_EVIDENCE_QUESTIONS,
  RECALL_EVIDENCE_SCHEMA_VERSION,
  RECALL_STATUS_OPTIONS,
  buildRecallState,
  fingerprintRecallState,
} from '../decision/recallEvidence.js'
import { SHADOW_POLICY_VERSION } from '../decision/shadowPolicy.js'
import type { DecisionLogSink, ShadowRunRecord } from '../decision/decisionLog.js'
import type { DecisionEngine, DecisionRequest, DecisionResult } from '../decision/types.js'

const NOW = new Date('2026-09-19T12:00:00.000Z')
const QUERY = 'how many cameras does Phoenix use'

interface Verdict { answers: number; status: string; evidence: number }

/** An engine whose verdict is looked up from the candidate content it is shown. */
const mockEngine = (verdicts: Record<string, Verdict | Error>) => {
  const evaluate = jest.fn(async (request: DecisionRequest): Promise<DecisionResult> => {
    const content = (request.state as any).candidate.content as string
    const verdict = verdicts[content]
    if (verdict instanceof Error) throw verdict
    if (!verdict) throw new Error(`no verdict for "${content}"`)
    const rest = (1 - 0.9) / (RECALL_STATUS_OPTIONS.length - 1)
    const level = Math.round(verdict.evidence)
    return {
      provider: 'mock',
      model: 'mock-1.0.0',
      requestedModel: 'mock-latest',
      answers: {
        answers_query: { type: 'noul', probability: verdict.answers },
        status: {
          type: 'choice',
          choice: verdict.status,
          probabilities: Object.fromEntries(RECALL_STATUS_OPTIONS.map(o => [o, o === verdict.status ? 0.9 : rest])),
          confidence: 0.85,
        },
        evidence_value: {
          type: 'score',
          score: verdict.evidence,
          probabilities: Object.fromEntries(EVIDENCE_VALUE_LEVELS.map((_, i) => [String(i), i === level ? 1 : 0])),
          confidence: 0.7,
        },
      },
      usage: { inputTokens: 400, outputTokens: 12 },
      latencyMs: 35,
      costUsdEstimate: 0.0000168,
      requestId: `req-${content}`,
    }
  })
  const engine: DecisionEngine = { provider: 'mock', requestedModel: 'mock-latest', evaluate }
  return { engine, evaluate }
}

const memorySink = () => {
  const rows: ShadowRunRecord[] = []
  const sink: DecisionLogSink = { write: jest.fn(async r => { rows.push(r) }) }
  return { sink, rows }
}

const RANKED = [
  { id: 'noise', content: 'phoenix session notes', _relevance: 0.6, confidence: 1, sourceSystem: 'graph', timestamp: '2026-09-01T00:00:00Z' },
  { id: 'old', content: 'phoenix had 6 cameras', _relevance: 0.5, confidence: 1, _sourceSystems: ['graph', 'mongodb'] },
  { id: 'answer', content: 'phoenix uses 16 cameras', _relevance: 0.4, _vectorSimilarity: 0.91, confidence: 0.6, sourceSystem: 'vector' },
]

const VERDICTS: Record<string, Verdict> = {
  'phoenix session notes': { answers: 0.05, status: 'irrelevant', evidence: 1 },
  'phoenix had 6 cameras': { answers: 0.7, status: 'superseded_context', evidence: 3 },
  'phoenix uses 16 cameras': { answers: 0.97, status: 'current', evidence: 4 },
}

describe('flags', () => {
  it('is OFF unless the flag is exactly "1"', () => {
    expect(isJevShadowRerankEnabled({})).toBe(false)
    expect(isJevShadowRerankEnabled({ KMS_JEV_SHADOW_RERANK: '0' })).toBe(false)
    expect(isJevShadowRerankEnabled({ KMS_JEV_SHADOW_RERANK: 'true' })).toBe(false)
    expect(isJevShadowRerankEnabled({ KMS_JEV_SHADOW_RERANK: '1' })).toBe(true)
  })

  it('logs only, unless reorder is also exactly "1"', () => {
    expect(jevShadowAction({})).toBe('shadow_log')
    expect(jevShadowAction({ KMS_JEV_SHADOW_REORDER: 'yes' })).toBe('shadow_log')
    expect(jevShadowAction({ KMS_JEV_SHADOW_REORDER: '1' })).toBe('shadow_reorder')
  })

  it('bounds top-K, because K is the number of model calls per search', () => {
    expect(jevShadowTopK({})).toBe(JEV_SHADOW_TOPK_DEFAULT)
    expect(jevShadowTopK({ KMS_JEV_SHADOW_TOPK: '5' })).toBe(5)
    expect(jevShadowTopK({ KMS_JEV_SHADOW_TOPK: '5000' })).toBe(JEV_SHADOW_TOPK_MAX)
    for (const bad of ['0', '-3', '2.5', 'many', '']) {
      expect(jevShadowTopK({ KMS_JEV_SHADOW_TOPK: bad })).toBe(JEV_SHADOW_TOPK_DEFAULT)
    }
  })
})

describe('buildRecallState', () => {
  it('shows the engine the pair and the correction metadata, and nothing about ranking', () => {
    const state = buildRecallState(QUERY, {
      id: 'x', content: 'c', contentType: 'fact', timestamp: '2026-04-13T10:00:00Z',
      confidence: 0.4, _score: 0.9, _relevance: 0.8, _vectorSimilarity: 0.95,
      superseded_by: 'new-id', metadata: { subject: 'Phoenix.camera_count', supersedes: 'older-id', update_history: [{}, {}] },
    }, NOW) as any

    expect(state).toEqual({
      query: QUERY,
      today: '2026-09-19',
      candidate: {
        content: 'c', content_truncated: false, content_type: 'fact', stored_at: '2026-04-13',
        subject: 'Phoenix.camera_count', correction_flag: null,
        replaced_by_later_entry: true, replaces_earlier_entry: true, times_edited: 2,
      },
    })
    // knowledge_confidence and every retrieval score stay out of the engine's sight, so
    // they cannot leak into a jev_* signal.
    const numbers = JSON.stringify(state).match(/\d+\.\d+/g) ?? []
    expect(numbers).toEqual([])
  })

  it('caps content and says so', () => {
    const state = buildRecallState(QUERY, { content: 'x'.repeat(RECALL_CANDIDATE_MAX_CHARS + 1) }, NOW) as any
    expect(state.candidate.content).toHaveLength(RECALL_CANDIDATE_MAX_CHARS)
    expect(state.candidate.content_truncated).toBe(true)
  })

  it('survives a candidate with no content, metadata or timestamp', () => {
    const state = buildRecallState(QUERY, { timestamp: 'not a date' }, NOW) as any
    expect(state.candidate).toMatchObject({ content: '', stored_at: null, subject: null, times_edited: 0 })
  })
})

describe('fingerprintRecallState', () => {
  const candidate = { content: 'phoenix uses 16 cameras', contentType: 'fact' }

  it('is stable across days — the clock is not part of what identifies an input', () => {
    expect(fingerprintRecallState(buildRecallState(QUERY, candidate, NOW)))
      .toBe(fingerprintRecallState(buildRecallState(QUERY, candidate, new Date('2027-01-01T00:00:00Z'))))
  })

  it('is independent of key order and changes with the query or the content', () => {
    const state = buildRecallState(QUERY, candidate, NOW) as Record<string, any>
    const reordered = { candidate: state.candidate, today: state.today, query: state.query }
    expect(fingerprintRecallState(reordered)).toBe(fingerprintRecallState(state))
    expect(fingerprintRecallState(buildRecallState('another query', candidate, NOW))).not.toBe(fingerprintRecallState(state))
    expect(fingerprintRecallState(buildRecallState(QUERY, { ...candidate, content: 'edited' }, NOW))).not.toBe(fingerprintRecallState(state))
  })
})

describe('runShadowRerank', () => {
  it('asks the three recall-evidence questions once per candidate', async () => {
    const { engine, evaluate } = mockEngine(VERDICTS)
    await runShadowRerank({ engine, query: QUERY, ranked: RANKED, action: 'shadow_log', now: NOW })

    expect(evaluate).toHaveBeenCalledTimes(3)
    for (const [request] of evaluate.mock.calls) {
      expect(request.questions).toBe(RECALL_EVIDENCE_QUESTIONS)
      expect(Object.keys(request.questions)).toEqual(['answers_query', 'status', 'evidence_value'])
    }
    expect(Object.keys(RECALL_EVIDENCE_QUESTIONS.status.criteria)).toEqual([...RECALL_STATUS_OPTIONS])
    expect(RECALL_EVIDENCE_QUESTIONS.evidence_value.criteria).toHaveLength(EVIDENCE_VALUE_LEVELS.length)
  })

  it('logs every field the brief requires', async () => {
    const { engine } = mockEngine(VERDICTS)
    const { sink, rows } = memorySink()
    await runShadowRerank({ engine, query: QUERY, ranked: RANKED, action: 'shadow_log', sink, now: NOW })

    expect(rows).toHaveLength(1)
    const run = rows[0]
    expect(run).toMatchObject({
      kind: 'recall_shadow_run',
      at: NOW.toISOString(),
      provider: 'mock',
      requested_model: 'mock-latest',
      models: ['mock-1.0.0'],
      question_schema_version: RECALL_EVIDENCE_SCHEMA_VERSION,
      policy_version: SHADOW_POLICY_VERSION,
      policy_decision: 'shadow_log',
      query: QUERY,
      candidates_in_pool: 3,
      candidates_evaluated: 3,
      candidates_failed: 0,
      usage: { input_tokens: 1200, output_tokens: 36 },
      cost_usd_estimate: 0.0000504,
      production_order: ['noise', 'old', 'answer'],
      shadow_order: null,
    })
    expect(typeof run.latency_ms).toBe('number')

    const answer = run.candidates[2]
    expect(answer).toMatchObject({
      id: 'answer',
      production_rank: 3,
      model: 'mock-1.0.0',
      request_id: 'req-phoenix uses 16 cameras',
      latency_ms: 35,
      usage: { input_tokens: 400, output_tokens: 12 },
      error: null,
      policy_shadow_score: null,
      policy_shadow_rank: null,
    })
    expect(answer.state_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(answer.jev!.answers_query).toEqual({ jev_probability: 0.97 })
    expect(answer.jev!.status.choice).toBe('current')
    expect(answer.jev!.status.jev_confidence).toBe(0.85)
    // Full distributions, not just the winner.
    expect(Object.keys(answer.jev!.status.jev_probabilities)).toEqual([...RECALL_STATUS_OPTIONS])
    expect(Object.keys(answer.jev!.evidence_value.jev_probabilities)).toEqual([...EVIDENCE_VALUE_LEVELS])
    expect(answer.jev!.evidence_value.jev_probabilities.direct).toBe(1)
  })

  it('keeps the signal namespaces apart', async () => {
    const { engine } = mockEngine(VERDICTS)
    const { sink, rows } = memorySink()
    await runShadowRerank({ engine, query: QUERY, ranked: RANKED, action: 'shadow_reorder', sink, now: NOW })
    const answer = rows[0].candidates[2]

    // Retrieval-side values are copied through untouched …
    expect(answer.retrieval).toEqual({
      source_systems: ['vector'],
      retrieval_relevance: 0.4,
      vector_similarity: 0.91,
      ontology_score: null,
      knowledge_confidence: 0.6,
    })
    // … and no engine value is ever stored under a name that means something else.
    expect(answer.retrieval.knowledge_confidence).not.toBe(answer.jev!.status.jev_confidence)
    const bareKeys: string[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      for (const [k, v] of Object.entries(node)) {
        if (['confidence', 'score', 'similarity', 'relevance'].includes(k)) bareKeys.push(k)
        walk(v)
      }
    }
    walk(answer.jev)
    // `score` is the Score primitive's own value, inside the jev block; nothing else bare.
    expect(bareKeys).toEqual(['score'])
  })

  it('does not write the candidate content into the log', async () => {
    const { engine } = mockEngine(VERDICTS)
    const { sink, rows } = memorySink()
    await runShadowRerank({ engine, query: QUERY, ranked: RANKED, action: 'shadow_reorder', sink, now: NOW })
    const serialised = JSON.stringify({ ...rows[0], candidates: rows[0].candidates.map(c => ({ ...c, request_id: null })) })
    for (const c of RANKED) expect(serialised).not.toContain(c.content)
  })

  it('computes a shadow ordering only under shadow_reorder, and never mutates the ranked input', async () => {
    const { engine } = mockEngine(VERDICTS)
    const ranked = RANKED.map(c => ({ ...c }))
    const snapshot = JSON.stringify(ranked)
    const run = await runShadowRerank({ engine, query: QUERY, ranked, action: 'shadow_reorder', now: NOW })

    expect(run.shadow_order).toEqual(['answer', 'old', 'noise'])
    expect(run.candidates.map(c => c.policy_shadow_rank)).toEqual([3, 2, 1])
    expect(run.candidates.every(c => typeof c.policy_shadow_score === 'number')).toBe(true)
    expect(run.production_order).toEqual(['noise', 'old', 'answer'])
    expect(JSON.stringify(ranked)).toBe(snapshot)
  })

  it('never demotes a strong ontology match the engine scores as irrelevant', async () => {
    const ranked = [
      { id: 'charles_yaker', content: 'Charles Jack Yaker — Person / father', _ontologyScore: 0.95 },
      ...RANKED,
    ]
    const { engine } = mockEngine({
      ...VERDICTS,
      'Charles Jack Yaker — Person / father': { answers: 0.02, status: 'irrelevant', evidence: 0 },
    })
    const run = await runShadowRerank({ engine, query: 'my dad', ranked, action: 'shadow_reorder', now: NOW })

    expect(run.shadow_order![0]).toBe('charles_yaker')
    expect(run.candidates[0].policy_protected).toBe('ontology_match')
    expect([...run.shadow_order!].sort()).toEqual(ranked.map(c => c.id).sort())
  })

  it('records a failed evaluation as a failure, keeps going, and does not demote the unjudged', async () => {
    const { engine } = mockEngine({ ...VERDICTS, 'phoenix session notes': new Error('gateway timeout') })
    const { sink, rows } = memorySink()
    const run = await runShadowRerank({ engine, query: QUERY, ranked: RANKED, action: 'shadow_reorder', sink, now: NOW })

    expect(run.candidates_failed).toBe(1)
    expect(run.candidates[0]).toMatchObject({ id: 'noise', jev: null, model: null, usage: null, error: 'Error: gateway timeout', policy_shadow_score: null })
    expect(run.shadow_order![0]).toBe('noise')
    // Totals cover what actually ran.
    expect(run.usage).toEqual({ input_tokens: 800, output_tokens: 24 })
    expect(rows).toHaveLength(1)
  })

  it('reports no cost total when any contributing estimate is missing', async () => {
    const { engine, evaluate } = mockEngine(VERDICTS)
    const real = evaluate.getMockImplementation()!
    evaluate.mockImplementation(async request => ({ ...(await real(request)), costUsdEstimate: null }))
    const run = await runShadowRerank({ engine, query: QUERY, ranked: RANKED, action: 'shadow_log', now: NOW })
    expect(run.cost_usd_estimate).toBeNull()
  })

  it('rejects an answer of the wrong kind rather than logging it as a judgment', async () => {
    const { engine, evaluate } = mockEngine(VERDICTS)
    const real = evaluate.getMockImplementation()!
    evaluate.mockImplementation(async request => {
      const result = await real(request)
      return { ...result, answers: { ...result.answers, status: { type: 'noul', probability: 0.5 } } }
    })
    const run = await runShadowRerank({ engine, query: QUERY, ranked: RANKED, action: 'shadow_log', now: NOW })
    expect(run.candidates_failed).toBe(3)
    expect(run.candidates[0].error).toMatch(/wrong kind/)
  })

  it('evaluates only the top K, and caps in-flight calls', async () => {
    let inFlight = 0
    let peak = 0
    const evaluate = jest.fn(async (): Promise<DecisionResult> => {
      peak = Math.max(peak, ++inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      throw new Error('irrelevant to this test')
    })
    const ranked = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, content: `content ${i}` }))
    const run = await runShadowRerank({
      engine: { provider: 'mock', requestedModel: 'm', evaluate }, query: QUERY, ranked, action: 'shadow_log', topK: 12, now: NOW,
    })

    expect(evaluate).toHaveBeenCalledTimes(12)
    expect(run.candidates_in_pool).toBe(30)
    expect(run.candidates_evaluated).toBe(12)
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('survives a log sink that throws', async () => {
    const { engine } = mockEngine(VERDICTS)
    const sink: DecisionLogSink = { write: jest.fn().mockRejectedValue(new Error('disk full')) }
    await expect(runShadowRerank({ engine, query: QUERY, ranked: RANKED, action: 'shadow_log', sink, now: NOW })).resolves.toMatchObject({ candidates_evaluated: 3 })
  })

  it('handles an empty pool without calling the engine', async () => {
    const { engine, evaluate } = mockEngine({})
    const run = await runShadowRerank({ engine, query: QUERY, ranked: [], action: 'shadow_reorder', now: NOW })
    expect(evaluate).not.toHaveBeenCalled()
    expect(run).toMatchObject({ candidates_evaluated: 0, shadow_order: [], cost_usd_estimate: null })
  })
})
