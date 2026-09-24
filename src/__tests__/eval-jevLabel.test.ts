/**
 * Tests for the Jev labeller (`../eval/jevLabel.ts`) — question shape, parsing an engine
 * answer into a grade, and the cache round-trip. No network: the engine is a mock.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { DecisionEngine, DecisionResult } from '../decision/types.js'
import {
  JEV_LABEL_QUESTION,
  appendJevLabelCacheEntry,
  jevLabelCacheKey,
  jevLabelState,
  judgeJevLabel,
  loadJevLabelCache,
  type JevLabelCacheEntry,
} from '../eval/jevLabel.js'
import { labelCacheKey } from '../scripts/label-recall-pool.js'

// ── question shape ───────────────────────────────────────────────────────────

describe('JEV_LABEL_QUESTION', () => {
  it('is a Choice question with exactly the three grade options', () => {
    expect(JEV_LABEL_QUESTION.type).toBe('choice')
    expect(Object.keys(JEV_LABEL_QUESTION.criteria).sort()).toEqual(['grade_0', 'grade_1', 'grade_2'])
  })

  it('criteria mirror the Gemma rubric verbatim (substance, not the redundant numeral prefix)', () => {
    expect(JEV_LABEL_QUESTION.criteria.grade_2).toContain('directly answers the query')
    expect(JEV_LABEL_QUESTION.criteria.grade_2).toContain('essential context for acting on it')
    expect(JEV_LABEL_QUESTION.criteria.grade_1).toContain('related and somewhat useful')
    expect(JEV_LABEL_QUESTION.criteria.grade_1).toContain('does not answer it')
    expect(JEV_LABEL_QUESTION.criteria.grade_0).toContain('not useful')
    expect(JEV_LABEL_QUESTION.criteria.grade_0).toContain('different topic, or only shares words')
  })

  it('has no dates or maths in its instructions (docs.typesafe.ai literal-reading rule)', () => {
    expect(JEV_LABEL_QUESTION.instructions).not.toMatch(/\btoday\b|\bdate\b/i)
  })
})

describe('jevLabelState', () => {
  it('is {query, candidate} with candidate the content string directly (not a nested object)', () => {
    expect(jevLabelState('q', 'content')).toEqual({ query: 'q', candidate: 'content' })
  })
})

// ── judgeJevLabel (engine mocked) ────────────────────────────────────────────

function mockEngine(answer: DecisionResult['answers']['grade']): { engine: DecisionEngine; evaluate: jest.Mock } {
  const evaluate = jest.fn(
    async (): Promise<DecisionResult> => ({
      provider: 'mock',
      model: 'mock-1',
      requestedModel: 'mock-1',
      answers: { grade: answer },
      usage: { inputTokens: 250, outputTokens: 5 },
      latencyMs: 15,
      costUsdEstimate: 0.0000105,
    })
  )
  return { engine: { provider: 'mock', requestedModel: 'mock-1', evaluate }, evaluate }
}

describe('judgeJevLabel', () => {
  it('parses a grade_2 choice into grade=2, carrying probabilities/confidence/cost through', async () => {
    const { engine } = mockEngine({
      type: 'choice',
      choice: 'grade_2',
      probabilities: { grade_0: 0.02, grade_1: 0.08, grade_2: 0.9 },
      confidence: 0.9,
    })
    const result = await judgeJevLabel(engine, 'q', 'content')
    expect(result.grade).toBe(2)
    expect(result.choice).toBe('grade_2')
    expect(result.confidence).toBe(0.9)
    expect(result.costUsdEstimate).toBe(0.0000105)
    expect(result.inputTokens).toBe(250)
  })

  it('computes expectedGrade as sum(p * grade) over the three options', async () => {
    const { engine } = mockEngine({
      type: 'choice',
      choice: 'grade_1',
      probabilities: { grade_0: 0.1, grade_1: 0.6, grade_2: 0.3 },
      confidence: 0.6,
    })
    const result = await judgeJevLabel(engine, 'q', 'content')
    // 0*0.1 + 1*0.6 + 2*0.3 = 1.2
    expect(result.expectedGrade).toBeCloseTo(1.2, 10)
  })

  it('throws when the engine returns an answer of the wrong kind', async () => {
    const { engine } = mockEngine({ type: 'noul', probability: 0.5 } as never)
    await expect(judgeJevLabel(engine, 'q', 'content')).rejects.toThrow(/wrong kind|expected "choice"/)
  })

  it('throws on an unknown choice id (a provider fault, never guessed)', async () => {
    const { engine } = mockEngine({ type: 'choice', choice: 'maybe', probabilities: { maybe: 1 }, confidence: 1 })
    await expect(judgeJevLabel(engine, 'q', 'content')).rejects.toThrow(/unknown choice/)
  })

  it('sends exactly one question ("grade") per call', async () => {
    const { engine, evaluate } = mockEngine({ type: 'choice', choice: 'grade_0', probabilities: { grade_0: 1 }, confidence: 1 })
    await judgeJevLabel(engine, 'q', 'content')
    const [request] = evaluate.mock.calls[0]
    expect(Object.keys(request.questions)).toEqual(['grade'])
  })
})

// ── cache key cross-check ────────────────────────────────────────────────────

describe('jevLabelCacheKey', () => {
  it('produces the SAME digest as label-recall-pool.ts\'s labelCacheKey for identical inputs — "cache the same way" per the brief', () => {
    expect(jevLabelCacheKey('q', 'id', 'content')).toBe(labelCacheKey('q', 'id', 'content'))
  })

  it('is a deterministic sha256 hex string that differs when any input differs', () => {
    const k = jevLabelCacheKey('q', 'id', 'content')
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(jevLabelCacheKey('q2', 'id', 'content')).not.toBe(k)
  })
})

// ── cache load/append ─────────────────────────────────────────────────────────

describe('loadJevLabelCache / appendJevLabelCacheEntry', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-jev-label-cache-test-'))

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('round-trips an entry written with appendJevLabelCacheEntry', () => {
    const file = path.join(tmpDir, 'jev-labels.jsonl')
    const entry: JevLabelCacheEntry = {
      grade: 2,
      choice: 'grade_2',
      probabilities: { grade_0: 0.05, grade_1: 0.05, grade_2: 0.9 },
      confidence: 0.9,
      expectedGrade: 1.85,
      costUsdEstimate: 0.00001,
      inputTokens: 250,
      outputTokens: 5,
    }
    appendJevLabelCacheEntry(file, 'k1', entry)
    const cache = loadJevLabelCache(file)
    expect(cache.get('k1')).toEqual(entry)
  })

  it('skips a malformed line without throwing, keeping the rest', () => {
    const file = path.join(tmpDir, 'jev-labels-partial.jsonl')
    fs.writeFileSync(
      file,
      ['not json', JSON.stringify({ key: 'k1', grade: 1, choice: 'grade_1' }), JSON.stringify({ key: 'k2' /* no grade */ })].join('\n')
    )
    const cache = loadJevLabelCache(file)
    expect(cache.get('k1')?.grade).toBe(1)
    expect(cache.has('k2')).toBe(false)
    expect(cache.size).toBe(1)
  })

  it('returns an empty map for a missing file', () => {
    expect(loadJevLabelCache(path.join(tmpDir, 'missing.jsonl')).size).toBe(0)
  })
})
