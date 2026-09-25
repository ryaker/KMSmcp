/**
 * Tests for the Claude Code session → KMS review-queue importer.
 *
 * No live KMS, no live Jev, no real transcripts (the repo is public — fixtures below are
 * fabricated). Coverage:
 *   - Transcript parsing: turn pairing, tool-result / sidechain / noise-prefix skipping,
 *     the 40-char floor
 *   - Injected KMS-recall-context stripping
 *   - Sophia hard-drop (noul threshold AND the code-side regex, independently)
 *   - Scoring, ranking, threshold with a stubbed Jev client
 *   - Store-arg shape (content, contentType, subject, review, writeMode)
 *   - cwd routing (eng vs personal)
 *   - Watermark idempotency, including through a full runSessionImport pass
 */

import {
  buildContent,
  buildContextPrefix,
  buildStoreArgs,
  computeScore,
  contentTypeForTopKind,
  extractTurnUnits,
  isEngCwd,
  isSophia,
  loadWatermark,
  parseArgs,
  projectFromCwd,
  rankAndKeep,
  routeForCwd,
  runSessionImport,
  saveWatermark,
  scoreUnits,
  SESSION_NOULS,
  SOPHIA_RE,
  stripInjectedContext,
  topDurableKind,
  watermarkPath,
  type CliOptions,
  type JevClassifyResult,
  type SessionJevClient,
  type SessionNoul,
  type TurnUnit
} from '../scripts/import-claude-session.js'

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ─────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'claude-session-import-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function userLine(content: string, extra: Record<string, any> = {}): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    uuid: extra.uuid ?? 'u-' + Math.random().toString(36).slice(2),
    timestamp: extra.timestamp ?? '2026-09-01T12:00:00Z',
    ...extra
  })
}

function toolResultLine(): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }] }
  })
}

function assistantTextLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
}

function assistantToolUseLine(): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: {} }] }
  })
}

function writeTranscript(lines: string[]): string {
  const path = join(tmpDir, 'session.jsonl')
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  return path
}

const LONG_ENOUGH = 'This is a real question from Rich that is long enough to clear the floor.'

// ─────────────────────────────────────────────────────────────────────────
// stripInjectedContext
// ─────────────────────────────────────────────────────────────────────────

describe('stripInjectedContext', () => {
  it('removes an ENG-KMS Memory Context block, keeping the real prompt around it', () => {
    const text =
      '[ENG-KMS Memory Context #1a2b3c4d]\nSome retrieved memory nobody typed.\n[End ENG-KMS Context #1a2b3c4d]\n' +
      LONG_ENOUGH
    expect(stripInjectedContext(text)).toBe(LONG_ENOUGH)
  })

  it('removes a plain KMS Memory Context block', () => {
    const text = `${LONG_ENOUGH}\n[KMS Memory Context #deadbeef]\nnoise\n[End KMS Context #deadbeef]`
    expect(stripInjectedContext(text)).toBe(LONG_ENOUGH)
  })

  it('leaves text with no injected block untouched (modulo trim)', () => {
    expect(stripInjectedContext(`  ${LONG_ENOUGH}  `)).toBe(LONG_ENOUGH)
  })

  it('does not touch mismatched nonces (different open/close markers)', () => {
    // Same content is used as both nonces here, but bracket text unrelated to the pattern
    // (no "Memory Context #" / "End ... Context #" pair) must survive untouched.
    const text = `${LONG_ENOUGH} [not a memory marker] still here`
    expect(stripInjectedContext(text)).toContain('[not a memory marker]')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// extractTurnUnits
// ─────────────────────────────────────────────────────────────────────────

describe('extractTurnUnits', () => {
  it('pairs a user turn with the assistant text that follows it', () => {
    const path = writeTranscript([
      userLine(LONG_ENOUGH),
      assistantToolUseLine(),
      assistantTextLine('Here is the final answer.')
    ])
    const units = extractTurnUnits(path)
    expect(units).toHaveLength(1)
    expect(units[0].userMessage).toBe(LONG_ENOUGH)
    expect(units[0].assistantExcerpt).toBe('Here is the final answer.')
  })

  it('skips tool-result turns entirely (not a turn boundary, not a candidate)', () => {
    const path = writeTranscript([
      userLine(LONG_ENOUGH),
      assistantToolUseLine(),
      toolResultLine(),
      assistantTextLine('Done.')
    ])
    const units = extractTurnUnits(path)
    expect(units).toHaveLength(1)
    expect(units[0].assistantExcerpt).toBe('Done.')
  })

  it('drops noise-prefixed turns (system-reminder, hook-injected)', () => {
    const path = writeTranscript([
      userLine('<system-reminder>Some injected system text that is definitely long enough</system-reminder>'),
      userLine(LONG_ENOUGH)
    ])
    const units = extractTurnUnits(path)
    expect(units).toHaveLength(1)
    expect(units[0].userMessage).toBe(LONG_ENOUGH)
  })

  it('drops subagent hand-backs and cross-session messages (not typed by the user)', () => {
    const path = writeTranscript([
      userLine('Another Claude session sent a message: <agent-message from="a1">report text here</agent-message>'),
      userLine('<cross-session-message from="peer">some long enough message body</cross-session-message>'),
      userLine(LONG_ENOUGH)
    ])
    const units = extractTurnUnits(path)
    expect(units).toHaveLength(1)
    expect(units[0].userMessage).toBe(LONG_ENOUGH)
  })

  it('drops turns under the 40-char floor', () => {
    const path = writeTranscript([userLine('ok thanks'), userLine(LONG_ENOUGH)])
    const units = extractTurnUnits(path)
    expect(units).toHaveLength(1)
    expect(units[0].userMessage).toBe(LONG_ENOUGH)
  })

  it('drops a turn that is entirely injected context once stripped', () => {
    const onlyInjected =
      '[KMS Memory Context #abc12345]\nsome long block of retrieved memory content here\n[End KMS Context #abc12345]'
    const path = writeTranscript([userLine(onlyInjected), userLine(LONG_ENOUGH)])
    const units = extractTurnUnits(path)
    expect(units).toHaveLength(1)
    expect(units[0].userMessage).toBe(LONG_ENOUGH)
  })

  it('skips sidechain (subagent) turns', () => {
    const path = writeTranscript([
      userLine(LONG_ENOUGH),
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'A subagent prompt, not Rich, but still long enough to pass the floor.' }
      })
    ])
    const units = extractTurnUnits(path)
    expect(units).toHaveLength(1)
    expect(units[0].userMessage).toBe(LONG_ENOUGH)
  })

  it('records the 1-based transcript line number', () => {
    const path = writeTranscript([assistantTextLine('preamble, ignored (no open turn)'), userLine(LONG_ENOUGH)])
    const units = extractTurnUnits(path)
    expect(units[0].line).toBe(2)
  })

  it('takes the LAST assistant text block as the excerpt, not the first', () => {
    const path = writeTranscript([
      userLine(LONG_ENOUGH),
      assistantTextLine('First, thinking out loud.'),
      assistantToolUseLine(),
      assistantTextLine('Final answer.')
    ])
    const units = extractTurnUnits(path)
    expect(units[0].assistantExcerpt).toBe('Final answer.')
  })

  it('has no assistantExcerpt when the assistant only used tools', () => {
    const path = writeTranscript([userLine(LONG_ENOUGH), assistantToolUseLine()])
    const units = extractTurnUnits(path)
    expect(units[0].assistantExcerpt).toBeNull()
  })

  it('tolerates malformed JSON lines without throwing', () => {
    const path = writeTranscript(['not json at all {{{', userLine(LONG_ENOUGH)])
    expect(() => extractTurnUnits(path)).not.toThrow()
    expect(extractTurnUnits(path)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Sophia hard-drop
// ─────────────────────────────────────────────────────────────────────────

const zeroNouls = (): Record<SessionNoul, number> =>
  Object.fromEntries(SESSION_NOULS.map(n => [n, 0.05])) as Record<SessionNoul, number>

const unit = (over: Partial<TurnUnit> = {}): TurnUnit => ({
  userMessage: LONG_ENOUGH,
  assistantExcerpt: null,
  timestamp: '2026-09-01T12:00:00Z',
  uuid: 'u1',
  line: 1,
  ...over
})

describe('SOPHIA_RE', () => {
  it('matches "Sophia" case-insensitively', () => {
    expect(SOPHIA_RE.test('We should change how Sophia responds to grief.')).toBe(true)
    expect(SOPHIA_RE.test('SOPHIA needs a new prompt')).toBe(true)
  })

  it('does not match the unrelated name "Sofia"', () => {
    expect(SOPHIA_RE.test('Sofia is a DolphinBench character, unrelated to the coach.')).toBe(false)
  })
})

describe('isSophia', () => {
  it('drops when mentions_sophia noul exceeds the threshold', () => {
    const nouls = { ...zeroNouls(), mentions_sophia: 0.5 }
    expect(isSophia(unit(), nouls)).toBe(true)
  })

  it('does NOT drop at exactly the threshold or below', () => {
    const nouls = { ...zeroNouls(), mentions_sophia: 0.3 }
    expect(isSophia(unit(), nouls)).toBe(false)
  })

  it('drops via the code-side regex even when the noul missed it (low score)', () => {
    const nouls = { ...zeroNouls(), mentions_sophia: 0.01 }
    expect(isSophia(unit({ userMessage: `${LONG_ENOUGH} — also, fix Sophia's onboarding flow.` }), nouls)).toBe(true)
  })

  it('checks the assistant excerpt too', () => {
    const nouls = zeroNouls()
    expect(isSophia(unit({ assistantExcerpt: 'I updated the Sophia persona prompt.' }), nouls)).toBe(true)
  })

  it('does not drop ordinary content', () => {
    expect(isSophia(unit(), zeroNouls())).toBe(false)
  })

  it('"Sofia" alone (no high noul) is never dropped', () => {
    expect(
      isSophia(unit({ userMessage: `${LONG_ENOUGH} Sofia is a different, unrelated name.` }), zeroNouls())
    ).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────

describe('computeScore + topDurableKind', () => {
  it('score is max(durable) * (1 - 0.5 * ephemeral)', () => {
    const nouls = {
      ...zeroNouls(),
      states_standing_rule: 0.9,
      decision_with_reason: 0.2,
      verified_fact_or_fix: 0.1,
      ephemeral: 0.5
    }
    expect(computeScore(nouls)).toBeCloseTo(0.675)
    expect(topDurableKind(nouls)).toBe('states_standing_rule')
  })

  it('ephemeral near 1 halves the score', () => {
    const nouls = { ...zeroNouls(), verified_fact_or_fix: 0.95, ephemeral: 0.98 }
    expect(computeScore(nouls)).toBeCloseTo(0.4845, 3)
  })

  it('a frustrated correction still clears the default threshold', () => {
    const nouls = { ...zeroNouls(), corrects_assistant: 0.9, ephemeral: 0.6 }
    expect(computeScore(nouls)).toBeGreaterThan(0.6)
    expect(topDurableKind(nouls)).toBe('corrects_assistant')
  })

  it('topDurableKind picks the highest of the three durable nouls', () => {
    const nouls = { ...zeroNouls(), decision_with_reason: 0.7, verified_fact_or_fix: 0.4 }
    expect(topDurableKind(nouls)).toBe('decision_with_reason')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// scoreUnits + rankAndKeep — stubbed Jev client
// ─────────────────────────────────────────────────────────────────────────

class StubJevClient implements SessionJevClient {
  public calls: Array<{ user_message: string; assistant_reply: string | null }> = []
  constructor(private readonly byMessage: Map<string, Record<SessionNoul, number>>) {}

  async classify(state: { user_message: string; assistant_reply: string | null }): Promise<JevClassifyResult> {
    this.calls.push(state)
    const nouls = this.byMessage.get(state.user_message) ?? zeroNouls()
    return { nouls, usage: { inputTokens: 100, outputTokens: 5 }, latencyMs: 42, costUsdEstimate: 0.0000042 }
  }
}

describe('scoreUnits', () => {
  it('drops Sophia units before they are ever scored/ranked', async () => {
    const units = [unit({ userMessage: 'Sophia needs a new tone for grief conversations, please.' })]
    const byMessage = new Map<string, Record<SessionNoul, number>>()
    const jev = new StubJevClient(byMessage)
    const stats = await scoreUnits(units, jev)
    expect(stats.sophiaDropped).toBe(1)
    expect(stats.scored).toHaveLength(0)
    expect(stats.jevCalls).toBe(1) // still classified — the drop happens after
  })

  it('scores every non-Sophia unit and tallies cost/latency', async () => {
    const u1 = unit({ userMessage: 'From now on always run the linter before committing code.' })
    const u2 = unit({ userMessage: 'What time is the standup tomorrow morning?' })
    const byMessage = new Map<string, Record<SessionNoul, number>>([
      [u1.userMessage, { ...zeroNouls(), states_standing_rule: 0.9, ephemeral: 0.05 }],
      [u2.userMessage, { ...zeroNouls(), ephemeral: 0.9 }]
    ])
    const jev = new StubJevClient(byMessage)
    const stats = await scoreUnits([u1, u2], jev)
    expect(stats.scored).toHaveLength(2)
    expect(stats.totalCostUsd).toBeCloseTo(0.0000084, 8)
    expect(stats.totalLatencyMs).toBe(84)
  })
})

describe('rankAndKeep', () => {
  it('filters below threshold, sorts descending, caps at max', () => {
    const scored = [
      { unit: unit({ uuid: 'a' }), nouls: zeroNouls(), score: 0.9, topKind: 'decision_with_reason' as const },
      { unit: unit({ uuid: 'b' }), nouls: zeroNouls(), score: 0.5, topKind: 'decision_with_reason' as const },
      { unit: unit({ uuid: 'c' }), nouls: zeroNouls(), score: 0.75, topKind: 'decision_with_reason' as const },
      { unit: unit({ uuid: 'd' }), nouls: zeroNouls(), score: 0.61, topKind: 'decision_with_reason' as const }
    ]
    const kept = rankAndKeep(scored, { threshold: 0.6, max: 2 })
    expect(kept.map(k => k.unit.uuid)).toEqual(['a', 'c'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Content + store args
// ─────────────────────────────────────────────────────────────────────────

describe('contentTypeForTopKind', () => {
  it('maps each topKind', () => {
    expect(contentTypeForTopKind('states_standing_rule')).toBe('pattern')
    expect(contentTypeForTopKind('decision_with_reason')).toBe('insight')
    expect(contentTypeForTopKind('verified_fact_or_fix')).toBe('fact')
  })
})

describe('buildContent', () => {
  it('includes the context prefix and the user message verbatim', () => {
    const content = buildContent(unit(), 'states_standing_rule', 'KMSmcp')
    expect(content).toBe(`${buildContextPrefix(unit(), 'KMSmcp')} ${LONG_ENOUGH}`)
  })

  it('appends a short assistant excerpt for decision/fact topKinds', () => {
    const u = unit({ assistantExcerpt: 'Switched to the token bucket approach.' })
    const content = buildContent(u, 'decision_with_reason', 'KMSmcp')
    expect(content).toContain('Assistant: Switched to the token bucket approach.')
  })

  it('does NOT append an assistant excerpt for a standing rule', () => {
    const u = unit({ assistantExcerpt: 'Sure, will do that from now on.' })
    const content = buildContent(u, 'states_standing_rule', 'KMSmcp')
    expect(content).not.toContain('Assistant:')
  })

  it('appends the reply for a correction, so the stored entry says what was corrected', () => {
    const u = unit({ assistantExcerpt: 'Understood: Jev is the default labeller.' })
    expect(buildContent(u, 'corrects_assistant', 'KMSmcp')).toContain('Assistant: Understood')
  })

  it('trims the user message to MAX_USER_CHARS', () => {
    const long = 'x'.repeat(1000)
    const content = buildContent(unit({ userMessage: long }), 'verified_fact_or_fix', 'KMSmcp')
    expect(content.length).toBeLessThan(700)
  })
})

describe('buildStoreArgs', () => {
  const ctx = { project: 'KMSmcp', sessionId: 'sess-1', userId: 'eng_kms', source: 'technical' as const, review: true }

  it('defaults to the review queue with writeMode standard', () => {
    const args = buildStoreArgs(unit(), zeroNouls(), 'decision_with_reason', ctx)
    expect(args.review).toBe('candidate')
    expect(args.writeMode).toBe('standard')
    expect(args.contentType).toBe('insight')
    expect(args.source).toBe('technical')
    expect(args.userId).toBe('eng_kms')
    expect(args.metadata.subject).toBe('ClaudeSession.decision_with_reason')
    expect(args.metadata.source).toBe('claude-session')
    expect(args.metadata.session_id).toBe('sess-1')
    expect(args.metadata.project).toBe('KMSmcp')
    expect(args.metadata.jev_scores).toBeDefined()
    expect(args.timestamp).toBe('2026-09-01T12:00:00Z')
  })

  it('omits review when review=false (--no-review)', () => {
    const args = buildStoreArgs(unit(), zeroNouls(), 'decision_with_reason', { ...ctx, review: false })
    expect(args.review).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// cwd routing
// ─────────────────────────────────────────────────────────────────────────

describe('isEngCwd / routeForCwd / projectFromCwd', () => {
  it('routes ~/Dev and /Volumes/Dev to eng', () => {
    expect(isEngCwd('/Users/ryaker/Dev/KMSmcp', '/Users/ryaker')).toBe(true)
    expect(isEngCwd('/Volumes/Dev/lumen-phoenix-scratch', '/Users/ryaker')).toBe(true)
  })

  it('routes everything else to personal', () => {
    expect(isEngCwd('/Users/ryaker/Documents/Notes', '/Users/ryaker')).toBe(false)
  })

  it('routeForCwd picks eng_kms / richard_yaker accordingly', () => {
    expect(routeForCwd('/Users/ryaker/Dev/KMSmcp', {}).userId).toBe('eng_kms')
    expect(routeForCwd('/Users/ryaker/Dev/KMSmcp', {}).source).toBe('technical')
    expect(routeForCwd('/Users/ryaker/Documents/Notes', {}).userId).toBe('richard_yaker')
    expect(routeForCwd('/Users/ryaker/Documents/Notes', {}).source).toBe('personal')
  })

  it('projectFromCwd takes the basename', () => {
    expect(projectFromCwd('/Users/ryaker/Dev/KMSmcp')).toBe('KMSmcp')
    expect(projectFromCwd('/Users/ryaker/Dev/KMSmcp/')).toBe('KMSmcp')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Watermark
// ─────────────────────────────────────────────────────────────────────────

describe('watermark', () => {
  it('defaults to lastLine 0 when absent', () => {
    const wm = loadWatermark(join(tmpDir, 'nope.json'))
    expect(wm.lastLine).toBe(0)
  })

  it('round-trips through save/load', () => {
    const path = watermarkPath('sess-xyz', tmpDir)
    saveWatermark(path, { lastLine: 42 })
    const wm = loadWatermark(path)
    expect(wm.lastLine).toBe(42)
    expect(wm.lastRun).toBeTruthy()
  })

  it('treats a malformed watermark file as absent rather than throwing', () => {
    const path = join(tmpDir, 'bad.json')
    writeFileSync(path, 'not json', 'utf8')
    expect(loadWatermark(path).lastLine).toBe(0)
  })
})

class FakeMcpClient {
  public calls: Array<{ name: string; args: any }> = []
  private responses: any[]
  constructor(responses: any[] = []) {
    this.responses = responses
  }
  async callTool(name: string, args: any) {
    this.calls.push({ name, args })
    if (this.responses.length > 0) return this.responses.shift()
    return { success: true, id: `kms-id-${this.calls.length}` }
  }
  async initialize() {}
  async close() {}
}

function baseOpts(over: Partial<CliOptions> = {}): CliOptions {
  return {
    transcript: '',
    cwd: '/Users/ryaker/Dev/KMSmcp',
    dryRun: false,
    max: 5,
    threshold: 0.6,
    review: true,
    watermarkDir: tmpDir,
    ...over
  }
}

describe('runSessionImport — watermark idempotency', () => {
  it('does not re-classify or re-store turns already behind the watermark', async () => {
    const highScore = { ...zeroNouls(), decision_with_reason: 0.95, ephemeral: 0.02 }
    const path = writeTranscript([
      userLine('We decided to use a token bucket for Jev rate limiting because it is simplest.')
    ])
    const opts = baseOpts({ transcript: path })
    const byMessage = new Map<string, Record<SessionNoul, number>>([
      ['We decided to use a token bucket for Jev rate limiting because it is simplest.', highScore]
    ])
    const jev1 = new StubJevClient(byMessage)
    const kms1 = new FakeMcpClient()

    const report1 = await runSessionImport(opts, { jev: jev1, kms: kms1 as any })
    expect(report1.turnsConsidered).toBe(1)
    expect(report1.stored).toBe(1)
    expect(kms1.calls).toHaveLength(1)

    // Second run over the SAME transcript, same watermark dir: nothing new to consider.
    const jev2 = new StubJevClient(byMessage)
    const kms2 = new FakeMcpClient()
    const report2 = await runSessionImport(opts, { jev: jev2, kms: kms2 as any })
    expect(report2.turnsConsidered).toBe(0)
    expect(report2.turnsParsed).toBe(1)
    expect(report2.stored).toBe(0)
    expect(jev2.calls).toHaveLength(0)
    expect(kms2.calls).toHaveLength(0)
  })

  it('a dry run never advances the watermark', async () => {
    const path = writeTranscript([userLine(LONG_ENOUGH)])
    const opts = baseOpts({ transcript: path, dryRun: true })
    const jev = new StubJevClient(new Map())

    await runSessionImport(opts, { jev, kms: null })
    const report2 = await runSessionImport(opts, { jev: new StubJevClient(new Map()), kms: null })
    expect(report2.turnsConsidered).toBe(1) // still fresh — dry run never wrote a watermark
  })
})

describe('runSessionImport — dedup handling', () => {
  it('skips (never forces) on dedup_required and does not retry', async () => {
    const highScore = { ...zeroNouls(), verified_fact_or_fix: 0.9, ephemeral: 0.02 }
    const path = writeTranscript([userLine('Confirmed the fix works: the token bucket now clamps to 20rps.')])
    const opts = baseOpts({ transcript: path })
    const byMessage = new Map<string, Record<SessionNoul, number>>([
      ['Confirmed the fix works: the token bucket now clamps to 20rps.', highScore]
    ])
    const jev = new StubJevClient(byMessage)
    const kms = new FakeMcpClient([{ status: 'dedup_required', success: false, candidates: [{ id: 'existing-1' }] }])

    const report = await runSessionImport(opts, { jev, kms: kms as any })
    expect(report.dedupSkipped).toBe(1)
    expect(report.stored).toBe(0)
    expect(report.failed).toBe(0)
    expect(kms.calls).toHaveLength(1) // exactly one attempt — never a forced retry
  })
})

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('applies sensible defaults', () => {
    const opts = parseArgs(['--transcript', '/tmp/x.jsonl', '--cwd', '/Users/ryaker/Dev/KMSmcp'])
    expect(opts.dryRun).toBe(false)
    expect(opts.max).toBe(5)
    expect(opts.threshold).toBe(0.6)
    expect(opts.review).toBe(true)
  })

  it('parses --dry-run, --max, --threshold, --no-review', () => {
    const opts = parseArgs([
      '--transcript',
      '/tmp/x.jsonl',
      '--cwd',
      '/tmp',
      '--dry-run',
      '--max',
      '3',
      '--threshold',
      '0.7',
      '--no-review'
    ])
    expect(opts.dryRun).toBe(true)
    expect(opts.max).toBe(3)
    expect(opts.threshold).toBe(0.7)
    expect(opts.review).toBe(false)
  })

  it('requires --transcript and --cwd', () => {
    expect(() => parseArgs(['--cwd', '/tmp'])).toThrow(/--transcript/)
    expect(() => parseArgs(['--transcript', '/tmp/x.jsonl'])).toThrow(/--cwd/)
  })

  it('rejects unknown flags', () => {
    expect(() =>
      parseArgs(['--transcript', '/tmp/x.jsonl', '--cwd', '/tmp', '--bogus'])
    ).toThrow(/Unknown flag/)
  })
})
