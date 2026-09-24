/**
 * runWriteDedupShadow — the per-write fan-out of Jev Experiment 2, against a mock engine.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  JEV_WRITE_DEDUP_MAX_CANDIDATES,
  buildWriteDedupResolution,
  isJevWriteDedupActRequested,
  isJevWriteDedupEnabled,
  jevWriteDedupMinSimilarity,
  runWriteDedupShadow,
  sha256,
  writeDedupLogFromEnv,
  type WriteDedupLogRow,
  type WriteDedupShadowCandidate,
  type WriteDedupShadowInput,
} from '../decision/writeDedupShadow.js'
import {
  WRITE_DEDUP_MAX_CHARS,
  WRITE_DEDUP_NOULS,
  WRITE_DEDUP_QUESTIONS,
  WRITE_DEDUP_RELATIONS,
  buildWriteDedupState,
  fingerprintWriteDedupState,
  toTier2Relation,
  type WriteDedupRelation,
} from '../decision/writeDedupRelation.js'
import type { DecisionEngine, DecisionLogSink, DecisionRequest, DecisionResult } from '../decision/index.js'
import { TokenBucket, setEngineRateLimiterForTests } from '../decision/engineSlot.js'

const NEW_CONTENT = 'Correction: the Phoenix rig uses 16 cameras, not 6. The 6-camera figure used the wrong zoom config.'
const SECRET_CANDIDATE_TEXT = 'The Phoenix rig uses 6 cameras per the March calibration session.'

const answers = (relation: WriteDedupRelation, p: number, nouls: Record<string, number> = {}): DecisionResult['answers'] => {
  const rest = (1 - p) / (WRITE_DEDUP_RELATIONS.length - 1)
  return {
    relation: {
      type: 'choice', choice: relation, confidence: 0.9,
      probabilities: Object.fromEntries(WRITE_DEDUP_RELATIONS.map(r => [r, r === relation ? p : rest])),
    },
    ...Object.fromEntries(WRITE_DEDUP_NOULS.map(id => [id, { type: 'noul' as const, probability: nouls[id] ?? 0.02 }])),
  }
}

const result = (a: DecisionResult['answers']): DecisionResult => ({
  provider: 'mock', model: 'mock-1', requestedModel: 'mock-latest', answers: a,
  usage: { inputTokens: 500, outputTokens: 12 }, latencyMs: 25, costUsdEstimate: 0.000021, requestId: 'req-1',
})

const mockEngine = (respond: (request: DecisionRequest) => DecisionResult['answers'] | Promise<never>) => {
  const evaluate = jest.fn(async (request: DecisionRequest) => result(await respond(request)))
  const engine: DecisionEngine = { provider: 'mock', requestedModel: 'mock-latest', evaluate }
  return { engine, evaluate }
}

const memoryLog = () => {
  const rows: WriteDedupLogRow[] = []
  const log: DecisionLogSink<WriteDedupLogRow> = { write: jest.fn(async r => { rows.push(r) }) }
  return { log, rows }
}

const candidate = (id: string, vectorSimilarity: number, over: Partial<WriteDedupShadowCandidate> = {}): WriteDedupShadowCandidate => ({
  id, vectorSimilarity, tier2Relation: null, contentPreview: `preview of ${id}`, contentType: 'fact', ...over,
})

const input = (over: Partial<WriteDedupShadowInput>): WriteDedupShadowInput => ({
  engine: mockEngine(() => answers('unrelated', 0.9)).engine,
  assertion: { entryId: 'new-1', content: NEW_CONTENT, contentType: 'fact', subject: 'Phoenix.camera_count', userId: 'richard_yaker' },
  gate: { outcome: 'dedup_required', band: 'confirm', thresholds: { refuse: 0.88, confirm: 0.78 } },
  candidates: [candidate('old-1', 0.84)],
  ...over,
})

describe('flags', () => {
  it('are strictly "1" and default off', () => {
    expect(isJevWriteDedupEnabled({})).toBe(false)
    expect(isJevWriteDedupEnabled({ KMS_JEV_WRITE_DEDUP: 'true' })).toBe(false)
    expect(isJevWriteDedupEnabled({ KMS_JEV_WRITE_DEDUP: '1' })).toBe(true)
    expect(isJevWriteDedupActRequested({})).toBe(false)
    expect(isJevWriteDedupActRequested({ KMS_JEV_WRITE_DEDUP_ACT: '1' })).toBe(true)
  })

  it('reads the similarity floor, ignoring nonsense', () => {
    expect(jevWriteDedupMinSimilarity({})).toBe(0.6)
    expect(jevWriteDedupMinSimilarity({ KMS_JEV_WRITE_DEDUP_MIN_SIM: '0.78' })).toBe(0.78)
    expect(jevWriteDedupMinSimilarity({ KMS_JEV_WRITE_DEDUP_MIN_SIM: '7' })).toBe(0.6)
    expect(jevWriteDedupMinSimilarity({ KMS_JEV_WRITE_DEDUP_MIN_SIM: 'high' })).toBe(0.6)
  })
})

describe('write-dedup questions and state', () => {
  it('offers exactly the six relations, matching the Tier 2 judge\'s vocabulary', () => {
    expect(Object.keys(WRITE_DEDUP_QUESTIONS.relation.criteria).sort()).toEqual([...WRITE_DEDUP_RELATIONS].sort())
    expect(WRITE_DEDUP_RELATIONS.map(toTier2Relation).sort()).toEqual(
      ['complement', 'contradicts', 'duplicate', 'supersedes', 'supersedes-reverse', 'unrelated']
    )
  })

  it('keeps Tier 1 / Tier 2 signals and stored confidence out of the state', () => {
    const state = buildWriteDedupState(
      { content: NEW_CONTENT, contentType: 'fact', subject: 'Phoenix.camera_count' },
      { content: SECRET_CANDIDATE_TEXT, contentType: 'fact', metadata: { supersedes: 'older', update_history: [{}, {}], confidence: 0.4, similarity: 0.9 } }
    ) as any
    expect(state.candidate).toEqual({
      content: SECRET_CANDIDATE_TEXT, content_truncated: false, content_type: 'fact', subject: null,
      replaces_earlier_entry: true, times_edited: 2,
    })
    expect(JSON.stringify(state)).not.toMatch(/similarity|confidence|llm_relation|older/)
  })

  it('caps both sides and records it; a preview counts as truncated', () => {
    const long = 'x'.repeat(WRITE_DEDUP_MAX_CHARS + 10)
    const state = buildWriteDedupState({ content: long }, { content: 'short', contentIsPreview: true }) as any
    expect(state.new_assertion.content).toHaveLength(WRITE_DEDUP_MAX_CHARS)
    expect(state.new_assertion.content_truncated).toBe(true)
    expect(state.candidate.content_truncated).toBe(true)
  })

  it('fingerprints by value, not key order', () => {
    const state = buildWriteDedupState({ content: 'a' }, { content: 'b' }) as Record<string, any>
    const reordered = { candidate: state.candidate, new_assertion: state.new_assertion }
    expect(fingerprintWriteDedupState(reordered)).toBe(fingerprintWriteDedupState(state))
    expect(fingerprintWriteDedupState(buildWriteDedupState({ content: 'a' }, { content: 'c' }))).not.toBe(fingerprintWriteDedupState(state))
  })
})

describe('runWriteDedupShadow', () => {
  it('judges each candidate over the hydrated entry and logs distributions + the proposal', async () => {
    const { engine, evaluate } = mockEngine(() => answers('supersedes', 0.92, { same_subject: 0.97, claims_conflict: 0.95, new_marks_correction: 0.96, new_adds_information: 0.9 }))
    const { log, rows } = memoryLog()
    const hydrate = jest.fn(async () => ({ content: SECRET_CANDIDATE_TEXT, metadata: { subject: 'Phoenix.camera_count' } }))

    const run = await runWriteDedupShadow(input({
      engine, sink: log, hydrate,
      candidates: [candidate('old-1', 0.84, { tier2Relation: 'contradicts' })],
      now: new Date('2026-09-19T12:00:00Z'),
    }))

    expect(evaluate).toHaveBeenCalledTimes(1)
    const request = evaluate.mock.calls[0][0] as any
    expect(request.questions).toBe(WRITE_DEDUP_QUESTIONS)
    expect(request.state.candidate.content).toBe(SECRET_CANDIDATE_TEXT)
    expect(request.state.new_assertion.content).toBe(NEW_CONTENT)

    expect(rows).toEqual([run])
    expect(run).toMatchObject({
      kind: 'write_dedup_shadow_run',
      at: '2026-09-19T12:00:00.000Z',
      provider: 'mock', requested_model: 'mock-latest', models: ['mock-1'],
      question_schema_version: 'write-dedup-relation/v1',
      policy_version: 'write-dedup-policy/v1',
      policy_decision: 'shadow_log',
      act_requested: false,
      assertion: { entry_id: 'new-1', content_sha256: sha256(NEW_CONTENT), content_chars: NEW_CONTENT.length, content_type: 'fact', subject: 'Phoenix.camera_count', user_id: 'richard_yaker' },
      gate: { outcome: 'dedup_required', band: 'confirm' },
      candidates_evaluated: 1, candidates_failed: 0,
      usage: { input_tokens: 500, output_tokens: 12 }, cost_usd_estimate: 0.000021,
      policy_proposal: 'suggest_supersede', policy_proposal_target_id: 'old-1',
    })
    const [c] = run.candidates
    expect(c).toMatchObject({
      id: 'old-1', vector_similarity: 0.84, gate_band: 'confirm', tier2_llm_relation: 'contradicts',
      content_truncated: false, policy_proposal: 'suggest_supersede', request_id: 'req-1', error: null,
    })
    expect(Object.keys(c.jev!.relation.jev_probabilities).sort()).toEqual([...WRITE_DEDUP_RELATIONS].sort())
    expect(c.jev!.nouls.new_marks_correction).toEqual({ jev_probability: 0.96 })
    expect(c.state_fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never writes entry content to the log', async () => {
    const { log, rows } = memoryLog()
    await runWriteDedupShadow(input({ sink: log, hydrate: async () => ({ content: SECRET_CANDIDATE_TEXT }) }))
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('Phoenix rig')
    expect(serialized).not.toContain('preview of')
  })

  it('falls back to the preview, marked truncated, when the entry cannot be read', async () => {
    const { engine, evaluate } = mockEngine(() => answers('unrelated', 0.9))
    const run = await runWriteDedupShadow(input({ engine, hydrate: async () => { throw new Error('graph down') } }))
    expect((evaluate.mock.calls[0][0] as any).state.candidate).toMatchObject({ content: 'preview of old-1', content_truncated: true })
    expect(run.candidates[0]).toMatchObject({ content_truncated: true, error: null })
  })

  it('a full engine queue costs that candidate its row, not the whole run', async () => {
    // One token, no queue: the first candidate gets the token, the second is refused at once.
    setEngineRateLimiterForTests(new TokenBucket({ ratePerSecond: 0.001, burst: 1, maxQueue: 0 }))
    try {
      const { engine, evaluate } = mockEngine(() => answers('unrelated', 0.9))
      const run = await runWriteDedupShadow(input({ engine, candidates: [candidate('a', 0.9), candidate('b', 0.85)] }))
      expect(evaluate).toHaveBeenCalledTimes(1)
      expect(run.candidates).toHaveLength(2)
      expect(run.candidates.filter(c => c.error === null)).toHaveLength(1)
      expect(run.candidates.find(c => c.error !== null)!.error).toMatch(/queue full/)
    } finally {
      setEngineRateLimiterForTests()
    }
  })

  it('skips candidates under the similarity floor and caps the fan-out', async () => {
    const { engine, evaluate } = mockEngine(() => answers('unrelated', 0.9))
    const { log, rows } = memoryLog()
    const many = Array.from({ length: 8 }, (_, i) => candidate(`c${i}`, 0.9 - i * 0.01))
    const run = await runWriteDedupShadow(input({ engine, sink: log, candidates: [...many, candidate('far', 0.3)], minSimilarity: 0.6 }))
    expect(evaluate).toHaveBeenCalledTimes(JEV_WRITE_DEDUP_MAX_CANDIDATES)
    expect(run.candidates_in_pool).toBe(9)
    expect(run.candidates.map(c => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(run.candidates.map(c => c.gate_band)).toEqual(['refuse', 'refuse', 'refuse', 'confirm', 'confirm'])
    expect(rows).toHaveLength(1)
  })

  it('writes no row when nothing clears the floor', async () => {
    const { engine, evaluate } = mockEngine(() => answers('unrelated', 0.9))
    const { log, rows } = memoryLog()
    const run = await runWriteDedupShadow(input({ engine, sink: log, candidates: [candidate('far', 0.3)] }))
    expect(evaluate).not.toHaveBeenCalled()
    expect(rows).toEqual([])
    expect(run.policy_proposal).toBeNull()
  })

  it('turns an engine failure into a row, keeps the other judgments, and aggregates over what succeeded', async () => {
    const { engine } = mockEngine(request =>
      (request.state as any).candidate.content.includes('bad')
        ? Promise.reject(new Error('401 access_restricted'))
        : answers('contradicts', 0.85, { same_subject: 0.9, claims_conflict: 0.9 })
    )
    const { log, rows } = memoryLog()
    const run = await runWriteDedupShadow(input({
      engine, sink: log,
      candidates: [candidate('bad', 0.9, { contentPreview: 'bad entry' }), candidate('good', 0.8)],
    }))
    expect(run.candidates_failed).toBe(1)
    expect(run.candidates[0]).toMatchObject({ id: 'bad', jev: null, policy_proposal: null, error: 'Error: 401 access_restricted' })
    expect(run).toMatchObject({ policy_proposal: 'escalate_contradiction', policy_proposal_target_id: 'good' })
    expect(rows).toHaveLength(1)
  })

  it('treats a wrong-kind answer as a failed candidate, not a measurement', async () => {
    const { engine } = mockEngine(() => ({ ...answers('duplicate', 0.99), same_subject: { type: 'score', score: 1, confidence: 1, probabilities: {} } }))
    const run = await runWriteDedupShadow(input({ engine }))
    expect(run.candidates[0].error).toMatch(/wrong kind.*same_subject/)
    expect(run.policy_proposal).toBeNull()
  })

  it('survives a log that cannot be written', async () => {
    const log: DecisionLogSink<WriteDedupLogRow> = { write: jest.fn(async () => { throw new Error('EACCES') }) }
    await expect(runWriteDedupShadow(input({ sink: log }))).resolves.toMatchObject({ kind: 'write_dedup_shadow_run' })
  })

  it('records that ACT was requested, and still only logs', async () => {
    const run = await runWriteDedupShadow(input({ actRequested: true }))
    expect(run).toMatchObject({ act_requested: true, policy_decision: 'shadow_log' })
  })

  it('does not mutate the candidates it is given', async () => {
    const candidates = [Object.freeze(candidate('old-1', 0.84))]
    await expect(runWriteDedupShadow(input({ candidates: Object.freeze(candidates) as any }))).resolves.toBeDefined()
  })
})

describe('buildWriteDedupResolution', () => {
  it('records the caller\'s action and target, joined by content hash, without the reason or the content', () => {
    const now = new Date('2026-09-19T12:00:00Z')
    expect(buildWriteDedupResolution({ content: NEW_CONTENT, action: 'supersede', old_id: 'old-1' }, now)).toEqual({
      kind: 'write_dedup_resolution', at: '2026-09-19T12:00:00.000Z',
      assertion: { content_sha256: sha256(NEW_CONTENT), content_chars: NEW_CONTENT.length },
      caller_action: 'supersede', target_id: 'old-1',
    })
    expect(buildWriteDedupResolution({ content: 'x', action: 'complement', related_to: 'rel-1', old_id: 'ignored' }).target_id).toBe('rel-1')
    expect(buildWriteDedupResolution({ content: 'x', action: 'force-new', old_id: 'ignored' }).target_id).toBeNull()
  })
})

describe('writeDedupLogFromEnv', () => {
  it('appends both row kinds as JSONL to KMS_WRITE_DEDUP_LOG_PATH, owner-only, apart from the recall log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-write-dedup-log-'))
    const file = path.join(dir, 'nested', 'write-dedup.jsonl')
    try {
      const sink = writeDedupLogFromEnv({ KMS_WRITE_DEDUP_LOG_PATH: file, KMS_DECISION_LOG_PATH: path.join(dir, 'recall.jsonl') })
      const run = await runWriteDedupShadow(input({ sink }))
      await sink.write(buildWriteDedupResolution({ content: NEW_CONTENT, action: 'supersede', old_id: 'old-1' }))

      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines.map(l => l.kind)).toEqual(['write_dedup_shadow_run', 'write_dedup_resolution'])
      expect(lines[0].run_id).toBe(run.run_id)
      expect(lines[1].assertion.content_sha256).toBe(lines[0].assertion.content_sha256)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.existsSync(path.join(dir, 'recall.jsonl'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
