/**
 * Pure-function tests for the relevance-labelling pipeline. No network: `gemmaGrade` and
 * `judgeCandidateV2` are exercised with an injected fetch stub / mock DecisionEngine, and
 * everything else here (query collection/dedup, cache key, resume, slicing, CLI parsing,
 * bypass detection) touches neither the network nor the filesystem.
 */
import {
  alreadyDoneKeys,
  buildLabelsForQuery,
  buildReport,
  buildSliceReport,
  bypassWasIgnored,
  capContent,
  classifyQueryKind,
  collectAllQueries,
  collectQueriesFromLog,
  computeQueryMetrics,
  gemmaGrade,
  gemmaGradePrompt,
  isRelevant,
  jevV2Order,
  judgeCandidateV2,
  labelCacheKey,
  labelLinesForMode,
  loadGradeCache,
  loadJevCache,
  loadPoolRows,
  parseArgs,
  poolRowKey,
  productionOrder,
  queryTag,
  reconstructProductionOrder,
  renderReport,
  seedGradeCacheFromPrototype,
  sliceRows,
  type PoolRow,
} from '../scripts/label-recall-pool.js'
import type { DecisionEngine, DecisionResult } from '../decision/types.js'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ── classifyQueryKind ────────────────────────────────────────────────────────

describe('classifyQueryKind', () => {
  it('classifies a substantive human sentence as human', () => {
    expect(classifyQueryKind('what runners are labeled bc26-int-ok on the M1 mini right now')).toBe('human')
  })

  it('classifies an agent/hook payload prefix as agent-payload', () => {
    expect(classifyQueryKind('You are a helpful assistant that must follow the rules below carefully')).toBe('agent-payload')
    expect(classifyQueryKind('<system>do the thing please and thank you</system>')).toBe('agent-payload')
    expect(classifyQueryKind('[SYSTEM] internal directive follows for the agent to obey')).toBe('agent-payload')
  })

  it('classifies a short query as agent-payload (length heuristic)', () => {
    expect(classifyQueryKind('short one')).toBe('agent-payload')
  })

  it('classifies a very long query as agent-payload (length heuristic)', () => {
    expect(classifyQueryKind('x '.repeat(400))).toBe('agent-payload')
  })

  it('classifies a low-word-count query as agent-payload', () => {
    expect(classifyQueryKind('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('agent-payload')
  })
})

// ── query collection + dedup ─────────────────────────────────────────────────

describe('collectQueriesFromLog', () => {
  it('extracts distinct queries in first-seen order, tagging the source', () => {
    const log = [
      JSON.stringify({ query: 'first substantive query about the system here' }),
      JSON.stringify({ query: 'second substantive query about something else' }),
      JSON.stringify({ query: 'first substantive query about the system here' }), // duplicate
    ].join('\n')
    const out = collectQueriesFromLog(log, 'eng')
    expect(out.map(o => o.query)).toEqual([
      'first substantive query about the system here',
      'second substantive query about something else',
    ])
    expect(out.every(o => o.source === 'eng')).toBe(true)
  })

  it('is lenient: a malformed line, a missing query field, or an empty line is skipped without failing the read', () => {
    const log = ['not json {{{', JSON.stringify({ no_query: true }), '', JSON.stringify({ query: 'a valid substantive query line here' })].join(
      '\n'
    )
    const out = collectQueriesFromLog(log, 'personal')
    expect(out).toHaveLength(1)
    expect(out[0].query).toBe('a valid substantive query line here')
  })

  it('trims whitespace before deduping', () => {
    const log = [
      JSON.stringify({ query: '  a substantive query with padding  ' }),
      JSON.stringify({ query: 'a substantive query with padding' }),
    ].join('\n')
    expect(collectQueriesFromLog(log, 'eng')).toHaveLength(1)
  })

  it('drops an empty/whitespace-only query', () => {
    const log = [JSON.stringify({ query: '   ' }), JSON.stringify({ query: '' })].join('\n')
    expect(collectQueriesFromLog(log, 'eng')).toHaveLength(0)
  })
})

describe('collectAllQueries', () => {
  it('keeps the SAME query text as two separate items when it appears in both logs (different corpora)', () => {
    const q = JSON.stringify({ query: 'a shared substantive query text here' })
    const out = collectAllQueries(q, q)
    expect(out).toHaveLength(2)
    expect(out.map(o => o.source).sort()).toEqual(['eng', 'personal'])
  })

  it('dedups independently within each source', () => {
    const engLog = [JSON.stringify({ query: 'eng substantive query number one here' })].join('\n')
    const personalLog = [
      JSON.stringify({ query: 'personal substantive query number one' }),
      JSON.stringify({ query: 'personal substantive query number two' }),
    ].join('\n')
    const out = collectAllQueries(engLog, personalLog)
    expect(out.filter(o => o.source === 'eng')).toHaveLength(1)
    expect(out.filter(o => o.source === 'personal')).toHaveLength(2)
  })
})

// ── cache key ────────────────────────────────────────────────────────────────

describe('labelCacheKey', () => {
  it('is a deterministic sha256 hex string', () => {
    const k = labelCacheKey('query text', 'cand-1', 'some content')
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(labelCacheKey('query text', 'cand-1', 'some content')).toBe(k)
  })

  it('differs when any of query/id/content differs', () => {
    const base = labelCacheKey('q', 'id', 'content')
    expect(labelCacheKey('q2', 'id', 'content')).not.toBe(base)
    expect(labelCacheKey('q', 'id2', 'content')).not.toBe(base)
    expect(labelCacheKey('q', 'id', 'content2')).not.toBe(base)
  })

  it('does not collide across a naive concatenation boundary ("ab"+"c" vs "a"+"bc")', () => {
    expect(labelCacheKey('ab', 'c', 'x')).not.toBe(labelCacheKey('a', 'bc', 'x'))
    expect(labelCacheKey('q', 'ab', 'c')).not.toBe(labelCacheKey('q', 'a', 'bc'))
  })
})

describe('capContent', () => {
  it('passes short content through unchanged', () => {
    expect(capContent('short')).toBe('short')
  })

  it('caps at exactly 1500 chars', () => {
    const long = 'x'.repeat(2000)
    const capped = capContent(long)
    expect(capped).toHaveLength(1500)
    expect(capped).toBe(long.slice(0, 1500))
  })
})

describe('queryTag', () => {
  it('never includes the raw query text (reports print ids, not content)', () => {
    const tag = queryTag('a secret-looking query with an api key sk-abc123')
    expect(tag).not.toContain('secret')
    expect(tag).not.toContain('sk-abc123')
    expect(tag).toMatch(/^sha256:[0-9a-f]{12} len=\d+$/)
  })
})

// ── grade cache + seeding ────────────────────────────────────────────────────

describe('seedGradeCacheFromPrototype', () => {
  it('seeds a cache entry keyed by sha256(query, id, content) for every graded candidate', () => {
    const cache = new Map<string, number>()
    const prototypePool = [
      JSON.stringify({
        query: 'protoype query text',
        candidates: [
          { id: 'cand-a', content: 'candidate a content', grade: 2 },
          { id: 'cand-b', content: 'candidate b content', grade: null }, // ungraded — must not seed
        ],
      }),
    ].join('\n')
    const seeded = seedGradeCacheFromPrototype(cache, prototypePool)
    expect(seeded).toBe(1)
    expect(cache.get(labelCacheKey('protoype query text', 'cand-a', 'candidate a content'))).toBe(2)
    expect(cache.has(labelCacheKey('protoype query text', 'cand-b', 'candidate b content'))).toBe(false)
  })

  it('does not overwrite an already-cached entry', () => {
    const key = labelCacheKey('q', 'cand-a', 'content')
    const cache = new Map<string, number>([[key, 0]])
    const prototypePool = JSON.stringify({ query: 'q', candidates: [{ id: 'cand-a', content: 'content', grade: 2 }] })
    const seeded = seedGradeCacheFromPrototype(cache, prototypePool)
    expect(seeded).toBe(0)
    expect(cache.get(key)).toBe(0)
  })

  it('skips malformed rows without throwing', () => {
    const cache = new Map<string, number>()
    const seeded = seedGradeCacheFromPrototype(cache, 'not json\n' + JSON.stringify({ query: 'q' }))
    expect(seeded).toBe(0)
  })
})

// ── Gemma grading (network mocked) ───────────────────────────────────────────

describe('gemmaGradePrompt', () => {
  it('matches the prototype prompt verbatim (so old and new labels are comparable)', () => {
    const prompt = gemmaGradePrompt('what is the deploy procedure', 'run npm run deploy')
    expect(prompt).toContain('You are grading search results from a personal engineering knowledge base.')
    expect(prompt).toContain('Query: what is the deploy procedure')
    expect(prompt).toContain('Stored entry:\nrun npm run deploy')
    expect(prompt).toContain('2 = it directly answers the query or is essential context for acting on it')
    expect(prompt).toContain('1 = related and somewhat useful, but does not answer it')
    expect(prompt).toContain('0 = not useful (different topic, or only shares words)')
    expect(prompt).toContain('Answer with JSON: {"grade": 0, 1, or 2}.')
  })
})

describe('gemmaGrade', () => {
  it('returns the parsed grade on a valid response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ json: async () => ({ response: JSON.stringify({ grade: 2 }) }) })
    const grade = await gemmaGrade('q', 'content', fetchImpl)
    expect(grade).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toContain('100.127.128.76')
    expect(url).not.toContain('localhost')
  })

  it('retries once on a network error, then returns the grade', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ json: async () => ({ response: JSON.stringify({ grade: 1 }) }) })
    const grade = await gemmaGrade('q', 'content', fetchImpl)
    expect(grade).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns null after two failed attempts, never throws', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('timeout'))
    await expect(gemmaGrade('q', 'content', fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns null when the response does not parse to {0,1,2}', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ json: async () => ({ response: JSON.stringify({ grade: 7 }) }) })
    await expect(gemmaGrade('q', 'content', fetchImpl)).resolves.toBeNull()
  })
})

// ── Jev v2 judging (engine mocked) ───────────────────────────────────────────

function mockEngine(overrides: Partial<DecisionResult['answers']> = {}): { engine: DecisionEngine; evaluate: jest.Mock } {
  const evaluate = jest.fn(
    async (): Promise<DecisionResult> => ({
      provider: 'mock',
      model: 'mock-1',
      requestedModel: 'mock-1',
      answers: {
        answers_query: { type: 'noul', probability: 0.9 },
        evidence_value: { type: 'score', score: 3.6, confidence: 0.8, probabilities: {} },
        contradicts_premise: { type: 'noul', probability: 0 },
        contains_instruction: { type: 'noul', probability: 0 },
        describes_past_state: { type: 'noul', probability: 0 },
        ...overrides,
      },
      usage: { inputTokens: 300, outputTokens: 10 },
      latencyMs: 20,
      costUsdEstimate: 0.0000126,
    })
  )
  return { engine: { provider: 'mock', requestedModel: 'mock-1', evaluate }, evaluate }
}

describe('judgeCandidateV2', () => {
  it('scores a candidate with shadowScoreV2 from the engine answers', async () => {
    const { engine } = mockEngine()
    const result = await judgeCandidateV2(engine, 'q', { id: 'c1', content: 'some content' })
    expect(result.score).toBeGreaterThan(0)
    expect(result.answersQuery).toBe(0.9)
    expect(result.evidenceValue).toBe(3.6)
  })

  it('applies the corrected/replaced multiplier when metadata marks the candidate as superseded', async () => {
    const { engine } = mockEngine()
    const fresh = await judgeCandidateV2(engine, 'q', { id: 'c1', content: 'x' })
    const corrected = await judgeCandidateV2(engine, 'q', { id: 'c1', content: 'x', metadata: { superseded_by: 'c2' } })
    expect(corrected.score).toBeLessThan(fresh.score)
  })

  it('throws when the engine returns an answer of the wrong kind', async () => {
    const { engine } = mockEngine({ answers_query: { type: 'choice', choice: 'x', probabilities: {}, confidence: 1 } as never })
    await expect(judgeCandidateV2(engine, 'q', { id: 'c1', content: 'x' })).rejects.toThrow(/wrong kind/)
  })
})

// ── bypass detection + production-order reconstruction ──────────────────────

describe('bypassWasIgnored', () => {
  it('is false when _rerank is absent', () => {
    expect(bypassWasIgnored({})).toBe(false)
    expect(bypassWasIgnored(undefined)).toBe(false)
  })

  it('is false when _rerank.applied is false', () => {
    expect(bypassWasIgnored({ _rerank: { applied: false } })).toBe(false)
  })

  it('is true when _rerank.applied is true (server ignored the bypass)', () => {
    expect(bypassWasIgnored({ _rerank: { applied: true } })).toBe(true)
  })
})

describe('reconstructProductionOrder', () => {
  it('sorts by _score descending', () => {
    const results = [
      { id: 'a', _score: 0.2 },
      { id: 'b', _score: 0.9 },
      { id: 'c', _score: 0.5 },
    ]
    expect(reconstructProductionOrder(results).map(r => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('treats a missing/non-numeric _score as 0, without throwing', () => {
    const results = [{ id: 'a', _score: undefined }, { id: 'b', _score: 0.1 }, { id: 'c' }]
    expect(reconstructProductionOrder(results as never).map((r: never) => (r as { id: string }).id)).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate the input array', () => {
    const results = [{ id: 'a', _score: 0.1 }, { id: 'b', _score: 0.9 }]
    const copy = [...results]
    reconstructProductionOrder(results)
    expect(results).toEqual(copy)
  })
})

// ── pool file: resume logic ──────────────────────────────────────────────────

const candidateRow = (id: string, grade: number | null, jevScore: number | null, rank: number) => ({
  id,
  prod_rank: rank,
  content: 'c',
  subject: null,
  sourceSystem: null,
  grade,
  jev: jevScore === null ? null : ({ score: jevScore } as never),
})

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

describe('poolRowKey / alreadyDoneKeys', () => {
  it('keys on (source, query) — the same query text against two sources is NOT the same key', () => {
    expect(poolRowKey('eng', 'q')).not.toBe(poolRowKey('personal', 'q'))
  })

  it('defaults label_source=gemma, topk=20 — matches the pre-labeller/topk pool format', () => {
    expect(poolRowKey('eng', 'q')).toBe(poolRowKey('eng', 'q', 'gemma', 20))
  })

  it('differs by label_source — a jev-labelled row is a different work item from a gemma one', () => {
    expect(poolRowKey('eng', 'q', 'gemma', 20)).not.toBe(poolRowKey('eng', 'q', 'jev', 20))
  })

  it('differs by topk — a top-50 row is a different work item from a top-20 one', () => {
    expect(poolRowKey('eng', 'q', 'jev', 20)).not.toBe(poolRowKey('eng', 'q', 'jev', 50))
  })

  it('alreadyDoneKeys reports exactly the (source, query) pairs present in the rows', () => {
    const rows = [poolRow({ source: 'eng', query: 'a' }), poolRow({ source: 'personal', query: 'a' }), poolRow({ source: 'eng', query: 'b' })]
    const done = alreadyDoneKeys(rows)
    expect(done.has(poolRowKey('eng', 'a'))).toBe(true)
    expect(done.has(poolRowKey('personal', 'a'))).toBe(true)
    expect(done.has(poolRowKey('eng', 'b'))).toBe(true)
    expect(done.has(poolRowKey('personal', 'b'))).toBe(false)
    expect(done.size).toBe(3)
  })

  it('a gemma@20 row and a jev@50 row for the SAME (source, query) are both tracked — a jev full run never skips an already gemma-graded query', () => {
    const rows = [
      poolRow({ source: 'eng', query: 'a', label_source: 'gemma', topk: 20 }),
      poolRow({ source: 'eng', query: 'a', label_source: 'jev', topk: 50 }),
    ]
    const done = alreadyDoneKeys(rows)
    expect(done.has(poolRowKey('eng', 'a', 'gemma', 20))).toBe(true)
    expect(done.has(poolRowKey('eng', 'a', 'jev', 50))).toBe(true)
    expect(done.size).toBe(2)
  })
})

describe('loadPoolRows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-label-pool-test-'))

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns [] for a file that does not exist, without throwing', () => {
    expect(loadPoolRows('/nonexistent/path/does-not-exist.jsonl')).toEqual([])
  })

  it('defaults label_source to "gemma" and topk to 20 for a legacy row missing those fields', () => {
    const file = path.join(tmpDir, 'legacy-pool.jsonl')
    const legacyRow = { query: 'q', source: 'eng', kind: 'human', at: '2026-09-01T00:00:00.000Z', production_path: 'bypass', candidates: [] }
    fs.writeFileSync(file, `${JSON.stringify(legacyRow)}\n`)
    const [row] = loadPoolRows(file)
    expect(row.label_source).toBe('gemma')
    expect(row.topk).toBe(20)
  })

  it('preserves label_source/topk when already present', () => {
    const file = path.join(tmpDir, 'current-pool.jsonl')
    fs.writeFileSync(file, `${JSON.stringify(poolRow({ label_source: 'jev', topk: 50 }))}\n`)
    const [row] = loadPoolRows(file)
    expect(row.label_source).toBe('jev')
    expect(row.topk).toBe(50)
  })
})

// ── grade/jev cache load (pure parsing over in-memory strings via a temp file) ──

describe('loadGradeCache / loadJevCache', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-label-test-'))

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loadGradeCache parses valid lines and skips malformed ones', () => {
    const file = path.join(tmpDir, 'grades.jsonl')
    fs.writeFileSync(file, ['not json', JSON.stringify({ key: 'k1', grade: 2 }), JSON.stringify({ key: 'k2' /* no grade */ })].join('\n'))
    const cache = loadGradeCache(file)
    expect(cache.get('k1')).toBe(2)
    expect(cache.has('k2')).toBe(false)
    expect(cache.size).toBe(1)
  })

  it('loadGradeCache returns an empty map for a missing file', () => {
    expect(loadGradeCache(path.join(tmpDir, 'missing.jsonl')).size).toBe(0)
  })

  it('loadJevCache parses valid lines (requires a numeric score) and skips malformed ones', () => {
    const file = path.join(tmpDir, 'jev.jsonl')
    fs.writeFileSync(
      file,
      ['garbage', JSON.stringify({ key: 'k1', score: 0.5, containsInstructionFlag: false, contradictsPremiseFlag: false })].join('\n')
    )
    const cache = loadJevCache(file)
    expect(cache.get('k1')?.score).toBe(0.5)
    expect(cache.size).toBe(1)
  })
})

// ── labels ───────────────────────────────────────────────────────────────────

describe('isRelevant', () => {
  it('strict: only grade 2 counts as relevant', () => {
    expect(isRelevant(2, 'strict')).toBe(true)
    expect(isRelevant(1, 'strict')).toBe(false)
    expect(isRelevant(0, 'strict')).toBe(false)
  })

  it('lenient: grade 1 or 2 counts as relevant', () => {
    expect(isRelevant(2, 'lenient')).toBe(true)
    expect(isRelevant(1, 'lenient')).toBe(true)
    expect(isRelevant(0, 'lenient')).toBe(false)
  })
})

describe('buildLabelsForQuery / labelLinesForMode', () => {
  const row = poolRow({
    query: 'the query',
    candidates: [candidateRow('a', 2, 0.9, 1), candidateRow('b', 1, 0.5, 2), candidateRow('c', null, null, 3)],
  })

  it('excludes ungraded candidates from the label map', () => {
    const strict = buildLabelsForQuery(row, 'strict')
    expect(Object.keys(strict).sort()).toEqual(['a', 'b'])
    expect(strict.a).toBe(1)
    expect(strict.b).toBe(0)
  })

  it('lenient labels grade>=1 as relevant', () => {
    const lenient = buildLabelsForQuery(row, 'lenient')
    expect(lenient.a).toBe(1)
    expect(lenient.b).toBe(1)
  })

  it('labelLinesForMode produces {query,labels} JSONL parseable by parseLabels', () => {
    const lines = labelLinesForMode([row], 'strict')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed).toEqual({ query: 'the query', labels: { a: 1, b: 0 } })
  })
})

// ── orderings ────────────────────────────────────────────────────────────────

describe('productionOrder / jevV2Order', () => {
  const row = poolRow({
    candidates: [candidateRow('a', 2, 0.2, 1), candidateRow('b', 1, 0.9, 2), candidateRow('c', 0, null, 3)],
  })

  it('productionOrder is prod_rank order', () => {
    expect(productionOrder(row).map(c => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('jevV2Order sorts by jev score descending; an unjudged candidate (no jev) sorts last', () => {
    expect(jevV2Order(row).map(c => c.id)).toEqual(['b', 'a', 'c'])
  })
})

// ── metrics + slicing ────────────────────────────────────────────────────────

describe('computeQueryMetrics', () => {
  it('excludes a query with no relevant candidate under a given mode', () => {
    const row = poolRow({ candidates: [candidateRow('a', 0, 0.9, 1), candidateRow('b', 0, 0.1, 2)] })
    expect(computeQueryMetrics(row)).toEqual([])
  })

  it('produces one row per mode that has at least one relevant candidate', () => {
    const row = poolRow({ candidates: [candidateRow('a', 2, 0.9, 1), candidateRow('b', 0, 0.1, 2)] })
    const out = computeQueryMetrics(row)
    expect(out.map(o => o.mode).sort()).toEqual(['lenient', 'strict'])
  })

  it('P@1 is 1 when the top-ranked candidate under that ordering is relevant', () => {
    // production top-1 = 'a' (relevant); jev top-1 = highest jev score = 'a' too (0.9)
    const row = poolRow({ candidates: [candidateRow('a', 2, 0.9, 1), candidateRow('b', 0, 0.1, 2)] })
    const [strict] = computeQueryMetrics(row).filter(r => r.mode === 'strict')
    expect(strict.prodTop1).toBe(1)
    expect(strict.jevTop1).toBe(1)
  })

  it('production and jev top-1 can disagree', () => {
    // production top-1 = 'a' (NOT relevant); jev orders 'b' (relevant) first by score
    const row = poolRow({ candidates: [candidateRow('a', 0, 0.1, 1), candidateRow('b', 2, 0.9, 2)] })
    const [strict] = computeQueryMetrics(row).filter(r => r.mode === 'strict')
    expect(strict.prodTop1).toBe(0)
    expect(strict.jevTop1).toBe(1)
  })
})

describe('sliceRows', () => {
  const rows = [
    { source: 'eng', kind: 'human', mode: 'strict', production: { p1: 1, p3: 1, ndcg10: 1, mrr: 1 }, jev: { p1: 1, p3: 1, ndcg10: 1, mrr: 1 }, prodTop1: 1, jevTop1: 1 },
    { source: 'personal', kind: 'agent-payload', mode: 'strict', production: { p1: 0, p3: 0, ndcg10: 0, mrr: 0 }, jev: { p1: 0, p3: 0, ndcg10: 0, mrr: 0 }, prodTop1: 0, jevTop1: 0 },
    { source: 'eng', kind: 'human', mode: 'lenient', production: { p1: 1, p3: 1, ndcg10: 1, mrr: 1 }, jev: { p1: 1, p3: 1, ndcg10: 1, mrr: 1 }, prodTop1: 1, jevTop1: 1 },
  ] as const

  it('slices by overall, source, and kind for the requested mode only', () => {
    const strictSlices = sliceRows([...rows], 'strict')
    expect(strictSlices.overall).toHaveLength(2)
    expect(strictSlices['source:eng']).toHaveLength(1)
    expect(strictSlices['source:personal']).toHaveLength(1)
    expect(strictSlices['kind:human']).toHaveLength(1)
    expect(strictSlices['kind:agent-payload']).toHaveLength(1)
  })

  it('an empty slice (no matching rows) is an empty array, not undefined', () => {
    const lenientSlices = sliceRows([...rows], 'lenient')
    expect(lenientSlices['source:personal']).toEqual([])
    expect(lenientSlices['kind:agent-payload']).toEqual([])
  })
})

describe('buildSliceReport', () => {
  it('does not throw and reports n=0 for an empty slice', () => {
    const report = buildSliceReport('source:personal', [])
    expect(report.n).toBe(0)
    expect(report.ci).toEqual({ mean: 0, lo: 0, hi: 0, iterations: 0 })
    expect(report.wins).toBe(0)
    expect(report.losses).toBe(0)
  })
})

describe('buildReport / renderReport', () => {
  it('builds strict and lenient slice reports and renders without throwing', () => {
    const row = poolRow({
      query: 'distinctive-query-marker-xyz123',
      source: 'eng',
      kind: 'human',
      candidates: [candidateRow('a', 2, 0.9, 1), candidateRow('b', 0, 0.1, 2)],
    })
    const metricRows = computeQueryMetrics(row)
    const report = buildReport(metricRows)
    expect(report.strict.map(s => s.slice).sort()).toEqual(['kind:agent-payload', 'kind:human', 'overall', 'source:eng', 'source:personal'])
    const text = renderReport(1, report)
    expect(text).toContain('STRICT')
    expect(text).toContain('LENIENT')
    // Report prints ids/slices/numbers, never raw query text.
    expect(text).not.toContain(row.query)
  })

  it('scores BOTH production order and the Jev v2 re-ranked order against Jev labels — no exclusion when label_source is "jev" (owner decision 2026-09-24)', () => {
    const row = poolRow({
      query: 'jev-labelled-query-marker',
      source: 'eng',
      kind: 'human',
      label_source: 'jev',
      topk: 20,
      // production order (rank) picks 'b' first; the v2 re-rank score picks 'a' first —
      // if both orderings are genuinely scored, production and jev metrics must differ.
      candidates: [candidateRow('b', 0, 0.1, 1), candidateRow('a', 2, 0.9, 2)],
    })
    const metricRows = computeQueryMetrics(row)
    const report = buildReport(metricRows)
    const overallStrict = report.strict.find(s => s.slice === 'overall')!
    // production top-1 ('b') is NOT relevant; jev-v2 top-1 ('a') IS — both are actually
    // computed (not one substituted for or excluded in favour of the other).
    expect(overallStrict.production.p1).toBe(0)
    expect(overallStrict.jev.p1).toBe(1)

    const text = renderReport(1, report)
    expect(text).toContain('production')
    expect(text).toContain('jev_v2')
  })
})

// ── CLI arg parsing ──────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults: no limit, source=all, not report-only, concurrency=1, labeler=gemma, topk=20', () => {
    expect(parseArgs([])).toEqual({ limit: null, source: 'all', reportOnly: false, concurrency: 1, labeler: 'gemma', topk: 20 })
  })

  it('parses --limit N and --limit=N', () => {
    expect(parseArgs(['--limit', '5']).limit).toBe(5)
    expect(parseArgs(['--limit=5']).limit).toBe(5)
  })

  it('parses --source and --source=', () => {
    expect(parseArgs(['--source', 'eng']).source).toBe('eng')
    expect(parseArgs(['--source=personal']).source).toBe('personal')
  })

  it('parses --report-only', () => {
    expect(parseArgs(['--report-only']).reportOnly).toBe(true)
  })

  it('parses --concurrency and --concurrency=', () => {
    expect(parseArgs(['--concurrency', '4']).concurrency).toBe(4)
    expect(parseArgs(['--concurrency=4']).concurrency).toBe(4)
  })

  it('rejects an invalid --source', () => {
    expect(() => parseArgs(['--source', 'bogus'])).toThrow(/--source must be/)
  })

  it('rejects a negative --limit', () => {
    expect(() => parseArgs(['--limit', '-1'])).toThrow(/--limit must be/)
  })

  it('clamps a non-finite/zero --concurrency to 1 rather than throwing', () => {
    expect(parseArgs(['--concurrency', '0']).concurrency).toBe(1)
    expect(parseArgs(['--concurrency', 'nope']).concurrency).toBe(1)
  })

  it('rejects an unrecognised flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unrecognised argument/)
  })

  it('parses --labeler and --labeler=', () => {
    expect(parseArgs(['--labeler', 'jev']).labeler).toBe('jev')
    expect(parseArgs(['--labeler=gemma']).labeler).toBe('gemma')
  })

  it('rejects an invalid --labeler', () => {
    expect(() => parseArgs(['--labeler', 'bogus'])).toThrow(/--labeler must be/)
  })

  it('parses --topk and --topk=', () => {
    expect(parseArgs(['--topk', '50']).topk).toBe(50)
    expect(parseArgs(['--topk=50']).topk).toBe(50)
  })

  it('rejects a non-positive or non-integer --topk', () => {
    expect(() => parseArgs(['--topk', '0'])).toThrow(/--topk must be/)
    expect(() => parseArgs(['--topk', '-5'])).toThrow(/--topk must be/)
    expect(() => parseArgs(['--topk', '3.5'])).toThrow(/--topk must be/)
    expect(() => parseArgs(['--topk', 'nope'])).toThrow(/--topk must be/)
  })

  it('combines multiple flags', () => {
    const args = parseArgs(['--limit', '2', '--source', 'eng', '--report-only', '--concurrency', '3', '--labeler', 'jev', '--topk', '50'])
    expect(args).toEqual({ limit: 2, source: 'eng', reportOnly: true, concurrency: 3, labeler: 'jev', topk: 50 })
  })
})
