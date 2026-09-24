/**
 * Tests for the Jev-label-vs-Gemma agreement script's pure item collection and the
 * network-calling label pass (engine mocked, cache is a plain in-memory Map — no real
 * filesystem needed since `appendJevLabelCacheEntry` just writes a line we never read back
 * in these tests).
 */
import type { DecisionEngine, DecisionResult } from '../decision/types.js'
import type { JevLabelCacheEntry } from '../eval/jevLabel.js'
import { labelCacheKey, type PoolRow } from '../scripts/label-recall-pool.js'
import { collectPoolItems, collectPrototypeItems, labelItems } from '../scripts/jev-label-agreement.js'

// ── collectPrototypeItems ─────────────────────────────────────────────────────

describe('collectPrototypeItems', () => {
  it('extracts one item per graded candidate, tagged source=prototype', () => {
    const text = JSON.stringify({
      query: 'a substantive prototype query about deploys',
      candidates: [
        { id: 'c1', content: 'content one', grade: 2 },
        { id: 'c2', content: 'content two', grade: 0 },
      ],
    })
    const items = collectPrototypeItems(text)
    expect(items).toHaveLength(2)
    expect(items.every(i => i.source === 'prototype')).toBe(true)
    expect(items[0]).toMatchObject({ id: 'c1', gemmaGrade: 2, kind: 'human' })
  })

  it('classifies kind the same way the live pipeline does', () => {
    const text = JSON.stringify({
      query: 'You are a helpful assistant that must obey the following rules exactly',
      candidates: [{ id: 'c1', content: 'x', grade: 1 }],
    })
    expect(collectPrototypeItems(text)[0].kind).toBe('agent-payload')
  })

  it('skips a candidate with a non-0/1/2 or missing grade', () => {
    const text = JSON.stringify({
      query: 'a substantive prototype query about deploys',
      candidates: [{ id: 'c1', content: 'x', grade: null }, { id: 'c2', content: 'y' }],
    })
    expect(collectPrototypeItems(text)).toHaveLength(0)
  })

  it('skips a malformed line without throwing', () => {
    const text = ['not json', JSON.stringify({ query: 'a substantive query line here for testing', candidates: [{ id: 'c1', content: 'x', grade: 2 }] })].join('\n')
    expect(collectPrototypeItems(text)).toHaveLength(1)
  })
})

// ── collectPoolItems ──────────────────────────────────────────────────────────

const poolRow = (over: Partial<PoolRow> = {}): PoolRow => ({
  query: 'q',
  source: 'eng',
  kind: 'human',
  at: '2026-09-24T00:00:00.000Z',
  production_path: 'bypass',
  label_source: 'gemma',
  topk: 20,
  candidates: [],
  ...over,
})

const poolCand = (id: string, grade: number | null) => ({
  id,
  prod_rank: 1,
  content: 'c',
  subject: null,
  sourceSystem: null,
  grade,
  jev: null,
})

describe('collectPoolItems', () => {
  it('extracts items from gemma-labelled rows, carrying source/kind through', () => {
    const rows = [poolRow({ source: 'eng', kind: 'human', candidates: [poolCand('a', 2), poolCand('b', 0)] })]
    const items = collectPoolItems(rows)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'a', gemmaGrade: 2, source: 'eng', kind: 'human' })
  })

  it('excludes rows whose label_source is "jev" — agreement is measured against GEMMA only', () => {
    const rows = [
      poolRow({ label_source: 'gemma', candidates: [poolCand('a', 2)] }),
      poolRow({ label_source: 'jev', candidates: [poolCand('b', 1)] }),
    ]
    const items = collectPoolItems(rows)
    expect(items.map(i => i.id)).toEqual(['a'])
  })

  it('excludes an ungraded candidate (grade: null)', () => {
    const rows = [poolRow({ candidates: [poolCand('a', null)] })]
    expect(collectPoolItems(rows)).toHaveLength(0)
  })
})

// ── labelItems (engine mocked) ────────────────────────────────────────────────

function mockEngine(gradeByContent: Record<string, string>): DecisionEngine {
  const evaluate = jest.fn(async (request: { state: { candidate: string } }): Promise<DecisionResult> => {
    const choice = gradeByContent[request.state.candidate] ?? 'grade_0'
    return {
      provider: 'mock',
      model: 'mock-1',
      requestedModel: 'mock-1',
      answers: { grade: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1 } },
      usage: { inputTokens: 100, outputTokens: 2 },
      latencyMs: 5,
      costUsdEstimate: 0.00001,
    }
  })
  return { provider: 'mock', requestedModel: 'mock-1', evaluate }
}

describe('labelItems', () => {
  it('labels every item not already cached, and pairs it with its gemma grade', async () => {
    const items = [
      { query: 'q1', id: 'a', content: 'content-a', gemmaGrade: 2 as const, source: 'eng' as const, kind: 'human' as const },
      { query: 'q2', id: 'b', content: 'content-b', gemmaGrade: 0 as const, source: 'personal' as const, kind: 'human' as const },
    ]
    const engine = mockEngine({ 'content-a': 'grade_2', 'content-b': 'grade_1' })
    const cache = new Map<string, JevLabelCacheEntry>()
    const { pairs, stats } = await labelItems(items, engine, cache, '/dev/null')
    expect(stats.newCalls).toBe(2)
    expect(stats.failed).toBe(0)
    expect(pairs).toHaveLength(2)
    const byId = Object.fromEntries(pairs.map((p, i) => [items[i].id, p]))
    expect(byId.a).toMatchObject({ gemmaGrade: 2, jevGrade: 2 })
    expect(byId.b).toMatchObject({ gemmaGrade: 0, jevGrade: 1 })
  })

  it('serves an already-cached pair without calling the engine again', async () => {
    const items = [{ query: 'q1', id: 'a', content: 'content-a', gemmaGrade: 2 as const, source: 'eng' as const, kind: 'human' as const }]
    const engine = mockEngine({ 'content-a': 'grade_2' })
    const cache = new Map<string, JevLabelCacheEntry>()
    const key = labelCacheKey('q1', 'a', 'content-a')
    cache.set(key, {
      grade: 1,
      choice: 'grade_1',
      probabilities: { grade_1: 1 },
      confidence: 1,
      expectedGrade: 1,
      costUsdEstimate: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
    const { pairs, stats } = await labelItems(items, engine, cache, '/dev/null')
    expect(stats.newCalls).toBe(0)
    expect(pairs[0].jevGrade).toBe(1) // the CACHED grade, not what the engine would have said
    expect((engine.evaluate as jest.Mock)).not.toHaveBeenCalled()
  })

  it('excludes a failed call from the pairs and counts it, never throwing', async () => {
    const items = [{ query: 'q1', id: 'a', content: 'content-a', gemmaGrade: 2 as const, source: 'eng' as const, kind: 'human' as const }]
    const engine: DecisionEngine = {
      provider: 'mock',
      requestedModel: 'mock-1',
      evaluate: jest.fn().mockRejectedValue(new Error('timeout')),
    }
    const cache = new Map<string, JevLabelCacheEntry>()
    const { pairs, stats } = await labelItems(items, engine, cache, '/dev/null')
    expect(stats.failed).toBe(1)
    expect(pairs).toHaveLength(0)
  })
})
