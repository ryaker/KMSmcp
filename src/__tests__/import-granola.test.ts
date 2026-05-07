/**
 * Tests for the Granola → KMS importer.
 *
 * Coverage:
 *   - Distillation prompt produces valid JSON / parseDistilledResponse strict checks
 *   - Sync-log resumability (skips meetings already in log)
 *   - Dedup-required response from KMS handled (skip + log, don't fail run)
 *   - Granola source failure handled gracefully (failure on one meeting doesn't
 *     stop the whole batch — we test the per-meeting boundary in processMeeting,
 *     and verify the batch loop in runImport rolls forward across mixed outcomes)
 *
 * No live KMS, no live Anthropic API. Everything is mocked at the seam.
 */

import {
  parseDistilledResponse,
  buildDistillPrompt,
  mapClaimTypeToContentType
} from '../scripts/granola-distill-prompt.js'

// Import the importer pieces. Note: scripts/import-granola.ts lives outside
// `src/`, so we use a relative path that ts-jest can resolve. The jest config
// (`roots: ['<rootDir>/src']`) only affects test discovery — TS imports can
// reach outside.
import {
  loadSyncLog,
  parseArgs,
  processMeeting,
  runImport,
  FileGranolaSource,
  MinimalMcpClient,
  GranolaSource,
  DistillerLike
} from '../../scripts/import-granola.js'
import type { DistilledMeeting } from '../scripts/granola-distill-prompt.js'

import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ─────────────────────────────────────────────────────────────────────────
// Distillation prompt — pure unit tests
// ─────────────────────────────────────────────────────────────────────────

describe('granola-distill-prompt', () => {
  describe('buildDistillPrompt', () => {
    it('locks the OB1 6-type taxonomy in the system prompt', () => {
      const { system } = buildDistillPrompt({
        title: 'Test',
        meetingId: 'g_1',
        transcript: 'A: hi\nB: bye'
      })
      // All six OB1 types must be enumerated
      for (const t of ['decision', 'preference', 'learning', 'context', 'brainstorm', 'reference']) {
        expect(system).toContain(t)
      }
    })

    it('includes the curate-don\'t-dump rule verbatim', () => {
      const { system } = buildDistillPrompt({
        title: 'Test',
        meetingId: 'g_1',
        transcript: 'transcript text'
      })
      expect(system).toContain(
        'Each claim must be a self-contained statement that makes sense without the original transcript context.'
      )
    })

    it('caps claims at 5 in the prompt instructions', () => {
      const { system } = buildDistillPrompt({
        title: 'Test',
        meetingId: 'g_1',
        transcript: 'x'
      })
      expect(system).toMatch(/2 to 5 claims|2-5 claims|2–5 claims/)
    })

    it('passes meeting metadata into the user prompt', () => {
      const { user } = buildDistillPrompt({
        title: 'KMSmcp sync',
        meetingId: 'gx_42',
        date: '2026-04-30',
        transcript: 'transcript here'
      })
      expect(user).toContain('KMSmcp sync')
      expect(user).toContain('gx_42')
      expect(user).toContain('2026-04-30')
      expect(user).toContain('transcript here')
    })
  })

  describe('parseDistilledResponse', () => {
    const validResponse = JSON.stringify({
      summary: 'A short summary of the meeting.',
      claims: [
        {
          type: 'decision',
          content: 'We decided to ship feature X next week.',
          confidence: 'firm',
          topics: ['shipping'],
          people: ['Rich']
        },
        {
          type: 'context',
          content: 'Q3 traffic is up 30% so capacity matters.',
          confidence: 'tentative',
          topics: ['capacity'],
          people: []
        }
      ]
    })

    it('parses a well-formed response', () => {
      const out = parseDistilledResponse(validResponse)
      expect(out.summary).toContain('short summary')
      expect(out.claims).toHaveLength(2)
      expect(out.claims[0].type).toBe('decision')
      expect(out.claims[0].confidence).toBe('firm')
    })

    it('strips ```json fences', () => {
      const wrapped = '```json\n' + validResponse + '\n```'
      const out = parseDistilledResponse(wrapped)
      expect(out.claims).toHaveLength(2)
    })

    it('strips bare ``` fences', () => {
      const wrapped = '```\n' + validResponse + '\n```'
      const out = parseDistilledResponse(wrapped)
      expect(out.claims).toHaveLength(2)
    })

    it('extracts JSON when leading prose is present', () => {
      const messy = 'Here is the JSON output:\n' + validResponse + '\nLet me know!'
      const out = parseDistilledResponse(messy)
      expect(out.summary).toContain('short summary')
    })

    it('throws on empty input', () => {
      expect(() => parseDistilledResponse('')).toThrow(/Empty/)
      expect(() => parseDistilledResponse('   ')).toThrow(/Empty/)
    })

    it('throws on invalid JSON', () => {
      expect(() => parseDistilledResponse('{ not valid')).toThrow(/not valid JSON/)
    })

    it('throws on missing summary', () => {
      const bad = JSON.stringify({ claims: [{ type: 'decision', content: 'x', confidence: 'firm', topics: [], people: [] }] })
      expect(() => parseDistilledResponse(bad)).toThrow(/summary/)
    })

    it('throws on zero claims', () => {
      const bad = JSON.stringify({ summary: 'foo', claims: [] })
      expect(() => parseDistilledResponse(bad)).toThrow(/zero claims/)
    })

    it('soft-caps to 5 claims when more are returned', () => {
      const sevenClaims = Array.from({ length: 7 }, (_, i) => ({
        type: 'context',
        content: `claim ${i}`,
        confidence: 'firm',
        topics: [],
        people: []
      }))
      const tooMany = JSON.stringify({ summary: 'x', claims: sevenClaims })
      const out = parseDistilledResponse(tooMany)
      expect(out.claims).toHaveLength(5)
    })

    it('rejects invalid claim types', () => {
      const bad = JSON.stringify({
        summary: 'x',
        claims: [{ type: 'yolo', content: 'x', confidence: 'firm', topics: [], people: [] }]
      })
      expect(() => parseDistilledResponse(bad)).toThrow(/invalid type/)
    })

    it('rejects invalid confidence values', () => {
      const bad = JSON.stringify({
        summary: 'x',
        claims: [{ type: 'decision', content: 'x', confidence: 'maybe', topics: [], people: [] }]
      })
      expect(() => parseDistilledResponse(bad)).toThrow(/invalid confidence/)
    })

    it('coerces missing/invalid topics + people to empty arrays', () => {
      const data = JSON.stringify({
        summary: 'x',
        claims: [{
          type: 'decision',
          content: 'y',
          confidence: 'firm',
          topics: ['a', 1, 'b'],
          people: 'not-an-array'
        }]
      })
      const out = parseDistilledResponse(data)
      expect(out.claims[0].topics).toEqual(['a', 'b'])
      expect(out.claims[0].people).toEqual([])
    })
  })

  describe('mapClaimTypeToContentType', () => {
    it('maps all six OB1 types', () => {
      expect(mapClaimTypeToContentType('decision')).toBe('insight')
      expect(mapClaimTypeToContentType('brainstorm')).toBe('insight')
      expect(mapClaimTypeToContentType('preference')).toBe('memory')
      expect(mapClaimTypeToContentType('context')).toBe('memory')
      expect(mapClaimTypeToContentType('learning')).toBe('fact')
      expect(mapClaimTypeToContentType('reference')).toBe('procedure')
    })

    it('falls back to memory on unknown types', () => {
      expect(mapClaimTypeToContentType('unknown-future-type')).toBe('memory')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('applies sensible defaults', () => {
    const opts = parseArgs([])
    expect(opts.timeRange).toBe('last_30_days')
    expect(opts.kmsUrl).toMatch(/^http/)
    expect(opts.dryRun).toBe(false)
  })

  it('parses --input and --dry-run', () => {
    const opts = parseArgs(['--input', '/tmp/foo.json', '--dry-run'])
    expect(opts.input).toBe('/tmp/foo.json')
    expect(opts.dryRun).toBe(true)
  })

  it('parses --max-meetings', () => {
    const opts = parseArgs(['--max-meetings', '7'])
    expect(opts.maxMeetings).toBe(7)
  })

  it('parses --bearer-token', () => {
    const opts = parseArgs(['--bearer-token', 'tok-123'])
    expect(opts.bearerToken).toBe('tok-123')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Sync log
// ─────────────────────────────────────────────────────────────────────────

describe('sync log', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'granola-import-test-'))
    logPath = join(tmpDir, '.kms-granola-sync.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty log when file does not exist', () => {
    expect(existsSync(logPath)).toBe(false)
    const log = loadSyncLog(logPath)
    expect(log.completed).toEqual([])
  })

  it('reads previously-stored completed IDs', () => {
    writeFileSync(logPath, JSON.stringify({ completed: ['m1', 'm2'], lastRun: '2026-01-01' }))
    const log = loadSyncLog(logPath)
    expect(log.completed).toEqual(['m1', 'm2'])
  })

  it('returns empty on malformed file (no throw)', () => {
    writeFileSync(logPath, 'not json at all')
    const log = loadSyncLog(logPath)
    expect(log.completed).toEqual([])
  })

  it('returns empty on file with wrong schema', () => {
    writeFileSync(logPath, JSON.stringify({ wrong: 'shape' }))
    const log = loadSyncLog(logPath)
    expect(log.completed).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// FileGranolaSource
// ─────────────────────────────────────────────────────────────────────────

describe('FileGranolaSource', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'granola-source-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads meetings from a JSON file', async () => {
    const path = join(tmpDir, 'm.json')
    writeFileSync(path, JSON.stringify([
      { id: 'g_1', title: 'A', transcript: 'hi', date: '2026-04-30' },
      { id: 'g_2', title: 'B', transcript: 'bye' }
    ]))
    const src = new FileGranolaSource(path)
    const meetings = await src.list()
    expect(meetings).toHaveLength(2)
    expect(meetings[0]).toEqual({ id: 'g_1', title: 'A', transcript: 'hi', date: '2026-04-30' })
    expect(meetings[1]).toEqual({ id: 'g_2', title: 'B', transcript: 'bye', date: undefined })
  })

  it('throws on missing file', async () => {
    const src = new FileGranolaSource(join(tmpDir, 'nope.json'))
    await expect(src.list()).rejects.toThrow(/not found/)
  })

  it('throws on non-array top-level', async () => {
    const path = join(tmpDir, 'm.json')
    writeFileSync(path, JSON.stringify({ not: 'an array' }))
    const src = new FileGranolaSource(path)
    await expect(src.list()).rejects.toThrow(/array/)
  })

  it('throws when a meeting is missing required fields', async () => {
    const path = join(tmpDir, 'm.json')
    writeFileSync(path, JSON.stringify([
      { id: 'g_1', title: 'A' }  // no transcript
    ]))
    const src = new FileGranolaSource(path)
    await expect(src.list()).rejects.toThrow(/required/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// processMeeting + runImport — wired to fakes
// ─────────────────────────────────────────────────────────────────────────

class FakeGranolaSource implements GranolaSource {
  constructor(private meetings: any[]) {}
  async list() { return this.meetings as any }
}

class FakeDistiller implements DistillerLike {
  constructor(private overrides: Partial<DistilledMeeting> = {}, private throwOn?: string) {}
  async distill(meeting: any): Promise<DistilledMeeting> {
    if (this.throwOn && meeting.id === this.throwOn) {
      throw new Error('haiku exploded')
    }
    return {
      summary: this.overrides.summary ?? `summary for ${meeting.title}`,
      claims: this.overrides.claims ?? [
        { type: 'decision', content: 'A decision.', confidence: 'firm', topics: [], people: [] },
        { type: 'context', content: 'A context.', confidence: 'tentative', topics: [], people: [] }
      ]
    }
  }
}

/**
 * A FakeMcpClient that records calls and returns canned responses keyed by
 * call sequence. Drop-in replacement for MinimalMcpClient (duck-typed via
 * the `callTool` method).
 */
class FakeMcpClient {
  public calls: Array<{ name: string; args: any }> = []
  private responses: any[]
  private idCounter = 0

  constructor(responses?: any[]) {
    this.responses = responses ?? []
  }

  async callTool(name: string, args: any) {
    this.calls.push({ name, args })
    if (this.responses.length > 0) {
      return this.responses.shift()
    }
    // Default: succeed with a fresh id.
    return {
      success: true,
      id: `kms-id-${++this.idCounter}`,
      storageDecision: { primary: 'graph', secondary: ['mem0'], cacheStrategy: 'L2', reasoning: 'fake' },
      cached: true,
      performance: { routingTime: 1, storageTime: 1, totalTime: 2 }
    }
  }

  async initialize() { /* noop */ }
  async close() { /* noop */ }
}

describe('processMeeting', () => {
  it('skips a meeting already in the sync log', async () => {
    const meeting = { id: 'm1', title: 'A', transcript: 'hi' }
    const result = await processMeeting(meeting, {
      source: new FakeGranolaSource([]),
      distiller: new FakeDistiller(),
      kms: new FakeMcpClient() as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: ['m1'] }
    })
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('sync log')
  })

  it('writes summary + N claim entries on the happy path', async () => {
    const meeting = { id: 'm2', title: 'B', transcript: 'hello world' }
    const kms = new FakeMcpClient()
    const result = await processMeeting(meeting, {
      source: new FakeGranolaSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('ok')
    expect(result.summaryEntryId).toBe('kms-id-1')
    expect(result.claimEntryIds).toEqual(['kms-id-2', 'kms-id-3'])

    // Verify dual-write contract
    expect(kms.calls).toHaveLength(3) // 1 summary + 2 claims
    const [summary, claim0, claim1] = kms.calls
    expect(summary.name).toBe('unified_store')
    expect(summary.args.contentType).toBe('memory')
    expect(summary.args.metadata.subject).toBe('Granola.B')
    expect(summary.args.metadata.source).toBe('granola')
    expect(summary.args.metadata.granola_meeting_id).toBe('m2')
    expect(summary.args.metadata.source_doc).toBe('granola://m2')

    expect(claim0.args.metadata.related_to).toEqual(['kms-id-1'])
    expect(claim0.args.metadata.source_doc).toBe('granola://m2')
    expect(claim0.args.metadata.subject).toBe('Granola.B.claim_0')
    expect(claim0.args.contentType).toBe('insight')   // decision → insight
    expect(claim1.args.contentType).toBe('memory')    // context → memory
  })

  it('handles dedup_required on summary write — counts as dedup_refused, not failed', async () => {
    const meeting = { id: 'm3', title: 'C', transcript: 'x' }
    const kms = new FakeMcpClient([
      {
        status: 'dedup_required',
        candidates: [{ id: 'existing-1', similarity: 0.92 }],
        message: 'dup found',
        retry_with: [],
        band: 'refuse',
        thresholds: { refuse: 0.88, confirm: 0.78 }
      }
    ])
    const result = await processMeeting(meeting, {
      source: new FakeGranolaSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('dedup_refused')
    expect(result.candidates?.[0]?.id).toBe('existing-1')
    // Critically: we did NOT proceed to write claims when summary refused
    expect(kms.calls).toHaveLength(1)
  })

  it('handles distillation failure (failed, with reason)', async () => {
    const meeting = { id: 'm4', title: 'D', transcript: 'x' }
    const kms = new FakeMcpClient()
    const result = await processMeeting(meeting, {
      source: new FakeGranolaSource([]),
      distiller: new FakeDistiller({}, 'm4'),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('haiku exploded')
    // No KMS calls — distillation gates the write path
    expect(kms.calls).toHaveLength(0)
  })

  it('continues past a single claim failure (counts meeting as ok if summary landed)', async () => {
    const meeting = { id: 'm5', title: 'E', transcript: 'x' }
    const kms = new FakeMcpClient([
      // 1: summary success
      { success: true, id: 'sum-1', storageDecision: {}, cached: false, performance: {} },
      // 2: claim 0 success
      { success: true, id: 'claim-0', storageDecision: {}, cached: false, performance: {} },
      // 3: claim 1 dedup_refused (non-fatal)
      { status: 'dedup_required', candidates: [{ id: 'existing' }], message: 'dup' }
    ])
    const result = await processMeeting(meeting, {
      source: new FakeGranolaSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('ok')
    expect(result.summaryEntryId).toBe('sum-1')
    expect(result.claimEntryIds).toEqual(['claim-0'])  // only the one that landed
  })

  it('dry-run path skips KMS calls entirely', async () => {
    const meeting = { id: 'm6', title: 'F', transcript: 'x' }
    const kms = new FakeMcpClient()
    const result = await processMeeting(meeting, {
      source: new FakeGranolaSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: true },
      log: { completed: [] }
    })
    expect(result.status).toBe('ok')
    expect(kms.calls).toHaveLength(0)
  })
})

describe('runImport', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'granola-runimport-test-'))
    logPath = join(tmpDir, '.kms-granola-sync.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rolls forward across mixed outcomes (skipped + ok + dedup_refused + failed)', async () => {
    const meetings = [
      { id: 'm-skip',   title: 'skip',  transcript: 'x' },
      { id: 'm-ok',     title: 'ok',    transcript: 'y' },
      { id: 'm-dedup',  title: 'dedup', transcript: 'z' },
      { id: 'm-fail',   title: 'fail',  transcript: 'w' }
    ]
    const kms = new FakeMcpClient([
      // m-ok: summary + 2 claims (3 calls)
      { success: true, id: 'sum-ok', storageDecision: {}, cached: false, performance: {} },
      { success: true, id: 'claim-0', storageDecision: {}, cached: false, performance: {} },
      { success: true, id: 'claim-1', storageDecision: {}, cached: false, performance: {} },
      // m-dedup: summary returns dedup_required (1 call, no claim writes)
      { status: 'dedup_required', candidates: [{ id: 'existing' }], message: 'dup' }
      // m-fail: distiller throws — no KMS calls
    ])

    const opts = { ...defaultOpts(), syncLogPath: logPath, dryRun: false }
    const log = { completed: ['m-skip'] }

    const report = await runImport({
      source: new FakeGranolaSource(meetings),
      distiller: new FakeDistiller({}, 'm-fail'),
      kms: kms as any,
      opts,
      log
    })

    expect(report.totalMeetings).toBe(4)
    expect(report.summaries).toBe(1)         // only m-ok
    expect(report.claims).toBe(2)            // 2 claims for m-ok
    expect(report.skipped).toEqual([{ id: 'm-skip', title: 'skip' }])
    expect(report.dedupRefused).toHaveLength(1)
    expect(report.dedupRefused[0].id).toBe('m-dedup')
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].id).toBe('m-fail')

    // Sync log was persisted with the new ok'd id
    const savedLog = JSON.parse(readFileSync(logPath, 'utf-8'))
    expect(savedLog.completed).toContain('m-skip')
    expect(savedLog.completed).toContain('m-ok')
    // failed and dedup-refused must NOT be added (so they retry on next run)
    expect(savedLog.completed).not.toContain('m-fail')
    expect(savedLog.completed).not.toContain('m-dedup')
  })

  it('respects --max-meetings cap', async () => {
    const meetings = Array.from({ length: 10 }, (_, i) => ({
      id: `m_${i}`, title: `M${i}`, transcript: 't'
    }))
    const kms = new FakeMcpClient()
    const opts = { ...defaultOpts(), syncLogPath: logPath, maxMeetings: 3, dryRun: false }
    const log = { completed: [] }
    const report = await runImport({
      source: new FakeGranolaSource(meetings),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts,
      log
    })
    expect(report.totalMeetings).toBe(3)
    expect(report.summaries).toBe(3)
    expect(report.claims).toBe(6) // 2 claims per meeting
  })

  it('survives a Granola-source data error per-meeting via processMeeting boundary', async () => {
    // The FileGranolaSource throws at .list() time on bad files (validated above).
    // For per-meeting failures inside the loop, the failure mode is "distiller
    // exploded for this transcript" — already covered by m-fail in the
    // mixed-outcomes test. This test pins down the contract: a thrown
    // distiller does not blow up sibling meetings.
    const meetings = [
      { id: 'a', title: 'A', transcript: 'x' },
      { id: 'b', title: 'B', transcript: 'y' },
      { id: 'c', title: 'C', transcript: 'z' }
    ]
    const kms = new FakeMcpClient()
    const report = await runImport({
      source: new FakeGranolaSource(meetings),
      distiller: new FakeDistiller({}, 'b'),  // only "b" fails
      kms: kms as any,
      opts: { ...defaultOpts(), syncLogPath: logPath, dryRun: false },
      log: { completed: [] }
    })
    expect(report.summaries).toBe(2)         // a + c
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].id).toBe('b')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// MinimalMcpClient — only the things that don't need a live server
// ─────────────────────────────────────────────────────────────────────────

describe('MinimalMcpClient', () => {
  it('throws if callTool is invoked before initialize', async () => {
    const c = new MinimalMcpClient('http://localhost:1', null)
    await expect(c.callTool('any', {})).rejects.toThrow(/not initialized/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function defaultOpts(): any {
  return {
    timeRange: 'last_30_days',
    kmsUrl: 'http://localhost:8180/mcp',
    syncLogPath: '/tmp/test-sync.json',
    userId: 'test-user',
    anthropicModel: 'claude-haiku-4-5',
    dryRun: true
  }
}
