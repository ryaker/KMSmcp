/**
 * Tests for the Slack Huddle → KMS importer.
 *
 * Coverage:
 *   - Distillation prompt produces valid JSON / parseDistilledResponse strict
 *   - Canvas-id regex extraction (the verified Slackbot-recap format)
 *   - Slackbot filter (only USLACKBOT messages with the recap phrase qualify)
 *   - Sync-log resumability (skips canvases already in log)
 *   - Dedup-required response from KMS handled (skip + log, don't fail run)
 *   - Failed-canvas-fetch graceful degradation (LiveSlackSource skips, doesn't throw)
 *   - Distillation JSON validation (malformed Haiku output rejected per-huddle)
 *   - File-source: both pre-resolved-array and messages+canvases shapes
 *   - Subject + source-doc helpers
 *   - CLI parseArgs sanity
 *
 * No live KMS, no live Anthropic API, no live Slack. Everything is mocked at the seam.
 */

import {
  buildDistillPrompt,
  extractCanvasId,
  isSlackbotHuddleRecap,
  mapClaimTypeToContentType,
  parseDistilledResponse
} from '../scripts/slack-huddle-distill-prompt.js'

import {
  buildHuddleSubject,
  buildSourceDoc,
  DEFAULT_SEARCH_QUERY,
  DistillerLike,
  FileSlackSource,
  LiveSlackSource,
  loadSyncLog,
  MinimalMcpClient,
  parseArgs,
  processHuddle,
  RawHuddle,
  runImport,
  SlackHuddleSource,
  slugifyChannel
} from '../scripts/import-slack-huddles.js'

import type { DistilledHuddle } from '../scripts/slack-huddle-distill-prompt.js'

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ─────────────────────────────────────────────────────────────────────────
// extractCanvasId
// ─────────────────────────────────────────────────────────────────────────

describe('extractCanvasId', () => {
  it('extracts team_id and file_id from the verified Slackbot recap format', () => {
    // The exact format observed on 2026-04-11 in #core-values
    const text =
      'AI huddle notes are ready. Edit, share, assign action items, ... :chipmunk: ' +
      '<https://projcaribou.slack.com/docs/T0123ABCD/F4567WXYZ|View AI Notes>'
    const ids = extractCanvasId(text)
    expect(ids).toEqual({ teamId: 'T0123ABCD', fileId: 'F4567WXYZ' })
  })

  it('handles the bare URL form (no mrkdwn wrapper)', () => {
    const text = 'AI huddle notes are ready: https://tengo.slack.com/docs/TX1/FY2'
    expect(extractCanvasId(text)).toEqual({ teamId: 'TX1', fileId: 'FY2' })
  })

  it('returns null when no docs URL is present', () => {
    expect(extractCanvasId('AI huddle notes are ready. (no link)')).toBeNull()
    expect(extractCanvasId('completely unrelated text')).toBeNull()
  })

  it('returns null on empty / non-string', () => {
    expect(extractCanvasId('')).toBeNull()
    expect(extractCanvasId(null as any)).toBeNull()
    expect(extractCanvasId(undefined as any)).toBeNull()
  })

  it('does not match files-app URLs (different path shape)', () => {
    // /files/ paths look similar but are not canvas docs
    expect(
      extractCanvasId('https://workspace.slack.com/files/UABC/F123/foo.pdf')
    ).toBeNull()
  })

  it('captures the FIRST docs match when multiple exist', () => {
    const text =
      'see https://workspace.slack.com/docs/T1/F1 and https://workspace.slack.com/docs/T2/F2'
    expect(extractCanvasId(text)).toEqual({ teamId: 'T1', fileId: 'F1' })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// isSlackbotHuddleRecap
// ─────────────────────────────────────────────────────────────────────────

describe('isSlackbotHuddleRecap', () => {
  it('matches messages with USLACKBOT user and the canonical phrase', () => {
    expect(
      isSlackbotHuddleRecap({
        user: 'USLACKBOT',
        text: 'AI huddle notes are ready. Edit, share, ...'
      })
    ).toBe(true)
  })

  it('matches messages with username "Slackbot" (alternative shape)', () => {
    expect(
      isSlackbotHuddleRecap({
        username: 'Slackbot',
        text: 'AI huddle notes are ready: see canvas'
      })
    ).toBe(true)
  })

  it('rejects messages from other users even with the recap phrase', () => {
    expect(
      isSlackbotHuddleRecap({
        user: 'U999HUMAN',
        text: 'AI huddle notes are ready'
      })
    ).toBe(false)
  })

  it('rejects Slackbot messages without the recap phrase', () => {
    expect(
      isSlackbotHuddleRecap({
        user: 'USLACKBOT',
        text: 'Some other Slackbot announcement'
      })
    ).toBe(false)
  })

  it('is case-insensitive on the recap phrase', () => {
    expect(
      isSlackbotHuddleRecap({
        user: 'uslackbot',
        text: 'AI Huddle Notes Are Ready... see attached'
      })
    ).toBe(true)
  })

  it('returns false on missing/invalid input', () => {
    expect(isSlackbotHuddleRecap(null as any)).toBe(false)
    expect(isSlackbotHuddleRecap({} as any)).toBe(false)
    expect(isSlackbotHuddleRecap({ text: 'foo' } as any)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Distillation prompt
// ─────────────────────────────────────────────────────────────────────────

describe('slack-huddle-distill-prompt', () => {
  describe('buildDistillPrompt', () => {
    it('locks the OB1 6-type taxonomy in the system prompt', () => {
      const { system } = buildDistillPrompt({
        channelName: 'core-values',
        canvasMarkdown: 'Notes here'
      })
      for (const t of [
        'decision',
        'preference',
        'learning',
        'context',
        'brainstorm',
        'reference'
      ]) {
        expect(system).toContain(t)
      }
    })

    it('locks qualitative_confidence values in the system prompt', () => {
      const { system } = buildDistillPrompt({
        channelName: 'x',
        canvasMarkdown: 'y'
      })
      expect(system).toContain('qualitative_confidence')
      for (const c of ['firm', 'tentative', 'exploring']) expect(system).toContain(c)
    })

    it('caps claims at 5 in instructions', () => {
      const { system } = buildDistillPrompt({
        channelName: 'x',
        canvasMarkdown: 'y'
      })
      expect(system).toMatch(/2 to 5 claims|2-5 claims|2–5 claims/)
    })

    it('passes channel + workspace + date into the user prompt', () => {
      const { user } = buildDistillPrompt({
        channelName: 'core-values',
        huddleDate: '2026-04-20T16:00:00Z',
        canvasMarkdown: 'transcript-ish content',
        workspace: 'tengo'
      })
      expect(user).toContain('core-values')
      expect(user).toContain('tengo')
      expect(user).toContain('2026-04-20')
      expect(user).toContain('transcript-ish content')
    })
  })

  describe('parseDistilledResponse', () => {
    const valid = JSON.stringify({
      summary: 'A short summary of the huddle.',
      claims: [
        {
          type: 'decision',
          content: 'We decided to ship feature X next week.',
          qualitative_confidence: 'firm',
          topics: ['shipping'],
          people: ['Rich']
        },
        {
          type: 'context',
          content: 'Q3 traffic up 30% so capacity matters.',
          qualitative_confidence: 'tentative',
          topics: ['capacity'],
          people: []
        }
      ]
    })

    it('parses a well-formed response', () => {
      const out = parseDistilledResponse(valid)
      expect(out.summary).toContain('short summary')
      expect(out.claims).toHaveLength(2)
      expect(out.claims[0].type).toBe('decision')
      expect(out.claims[0].qualitative_confidence).toBe('firm')
    })

    it('strips ```json fences', () => {
      const out = parseDistilledResponse('```json\n' + valid + '\n```')
      expect(out.claims).toHaveLength(2)
    })

    it('strips bare ``` fences', () => {
      const out = parseDistilledResponse('```\n' + valid + '\n```')
      expect(out.claims).toHaveLength(2)
    })

    it('extracts JSON when leading/trailing prose is present', () => {
      const messy = 'Here is the JSON output:\n' + valid + '\nThanks!'
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
      const bad = JSON.stringify({
        claims: [
          {
            type: 'decision',
            content: 'x',
            qualitative_confidence: 'firm',
            topics: [],
            people: []
          }
        ]
      })
      expect(() => parseDistilledResponse(bad)).toThrow(/summary/)
    })

    it('throws on zero claims', () => {
      const bad = JSON.stringify({ summary: 'foo', claims: [] })
      expect(() => parseDistilledResponse(bad)).toThrow(/zero claims/)
    })

    it('soft-caps to 5 claims when more are returned', () => {
      const seven = Array.from({ length: 7 }, (_, i) => ({
        type: 'context',
        content: `c${i}`,
        qualitative_confidence: 'firm',
        topics: [],
        people: []
      }))
      const out = parseDistilledResponse(
        JSON.stringify({ summary: 'x', claims: seven })
      )
      expect(out.claims).toHaveLength(5)
    })

    it('rejects invalid claim types', () => {
      const bad = JSON.stringify({
        summary: 'x',
        claims: [
          {
            type: 'yolo',
            content: 'x',
            qualitative_confidence: 'firm',
            topics: [],
            people: []
          }
        ]
      })
      expect(() => parseDistilledResponse(bad)).toThrow(/invalid type/)
    })

    it('rejects invalid qualitative_confidence values', () => {
      const bad = JSON.stringify({
        summary: 'x',
        claims: [
          {
            type: 'decision',
            content: 'x',
            qualitative_confidence: 'maybe',
            topics: [],
            people: []
          }
        ]
      })
      expect(() => parseDistilledResponse(bad)).toThrow(/invalid qualitative_confidence/)
    })

    it('coerces missing/invalid topics + people to clean arrays', () => {
      const data = JSON.stringify({
        summary: 'x',
        claims: [
          {
            type: 'decision',
            content: 'y',
            qualitative_confidence: 'firm',
            topics: ['a', 1, 'b'],
            people: 'not-an-array'
          }
        ]
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
      expect(mapClaimTypeToContentType('learning')).toBe('insight')
      expect(mapClaimTypeToContentType('preference')).toBe('memory')
      expect(mapClaimTypeToContentType('context')).toBe('memory')
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
    expect(opts.source).toBe('file')
    expect(opts.searchQuery).toBe(DEFAULT_SEARCH_QUERY)
    expect(opts.searchLimit).toBe(20)
    expect(opts.kmsUrl).toMatch(/^http/)
    expect(opts.dryRun).toBe(false)
    expect(opts.workspace).toBeTruthy()
  })

  it('parses --input and --dry-run', () => {
    const opts = parseArgs(['--input', '/tmp/foo.json', '--dry-run'])
    expect(opts.input).toBe('/tmp/foo.json')
    expect(opts.dryRun).toBe(true)
  })

  it('parses --source live', () => {
    const opts = parseArgs(['--source', 'live'])
    expect(opts.source).toBe('live')
  })

  it('rejects --source bogus', () => {
    expect(() => parseArgs(['--source', 'bogus'])).toThrow(/Invalid --source/)
  })

  it('parses --max-huddles, --workspace, --bearer-token', () => {
    const opts = parseArgs([
      '--max-huddles',
      '7',
      '--workspace',
      'mymoneycoach',
      '--bearer-token',
      'tok-abc'
    ])
    expect(opts.maxHuddles).toBe(7)
    expect(opts.workspace).toBe('mymoneycoach')
    expect(opts.bearerToken).toBe('tok-abc')
  })

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--unknown-flag'])).toThrow(/Unknown flag/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Subject + source-doc helpers
// ─────────────────────────────────────────────────────────────────────────

describe('subject + source-doc helpers', () => {
  it('slugifies channel names', () => {
    expect(slugifyChannel('Core Values')).toBe('core-values')
    expect(slugifyChannel('core-values')).toBe('core-values')
    expect(slugifyChannel('OPS_Daily Sync!')).toBe('ops_daily-sync')
    expect(slugifyChannel('')).toBe('unknown')
  })

  it('builds the canonical subject', () => {
    const huddle: RawHuddle = {
      channelId: 'C1',
      channelName: 'core-values',
      messageTs: '1000',
      teamId: 'T1',
      fileId: 'F1',
      huddleDate: '2026-04-11T16:00:00Z',
      canvasMarkdown: 'x'
    }
    expect(buildHuddleSubject(huddle)).toBe('Slack.huddle.core-values.2026-04-11')
  })

  it('builds the canonical source_doc URI', () => {
    const huddle: RawHuddle = {
      channelId: 'C1',
      channelName: 'x',
      messageTs: '1',
      teamId: 'T0123ABCD',
      fileId: 'F4567WXYZ',
      canvasMarkdown: 'y'
    }
    expect(buildSourceDoc(huddle)).toBe('slack://canvas/T0123ABCD/F4567WXYZ')
  })

  it('subject falls back to "unknown-date" when huddle date missing', () => {
    const huddle: RawHuddle = {
      channelId: 'C1',
      channelName: 'general',
      messageTs: 'invalid',
      teamId: 'T1',
      fileId: 'F1',
      canvasMarkdown: 'x'
    }
    expect(buildHuddleSubject(huddle)).toBe('Slack.huddle.general.unknown-date')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Sync log
// ─────────────────────────────────────────────────────────────────────────

describe('sync log', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slack-huddle-import-test-'))
    logPath = join(tmpDir, '.kms-slack-huddle-sync.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty log when file does not exist', () => {
    expect(existsSync(logPath)).toBe(false)
    expect(loadSyncLog(logPath).completed).toEqual([])
  })

  it('reads previously-stored canvas IDs', () => {
    writeFileSync(
      logPath,
      JSON.stringify({ completed: ['F1', 'F2'], lastRun: '2026-01-01' })
    )
    const log = loadSyncLog(logPath)
    expect(log.completed).toEqual(['F1', 'F2'])
  })

  it('returns empty on malformed file (no throw)', () => {
    writeFileSync(logPath, 'definitely not json')
    expect(loadSyncLog(logPath).completed).toEqual([])
  })

  it('returns empty on file with wrong schema', () => {
    writeFileSync(logPath, JSON.stringify({ wrong: 'shape' }))
    expect(loadSyncLog(logPath).completed).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// FileSlackSource — both shapes
// ─────────────────────────────────────────────────────────────────────────

describe('FileSlackSource', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slack-source-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads the pre-resolved-array shape', async () => {
    const path = join(tmpDir, 'h.json')
    writeFileSync(
      path,
      JSON.stringify([
        {
          channel_id: 'C1',
          channel_name: 'core-values',
          message_ts: '1714098000.000400',
          team_id: 'T0123ABCD',
          file_id: 'F4567WXYZ',
          huddle_date: '2026-04-11T16:00:00Z',
          canvas_markdown: '# Notes\nDecided X.'
        },
        {
          channel_id: 'C2',
          channel_name: 'general',
          message_ts: '1714184400.000000',
          team_id: 'T0123ABCD',
          file_id: 'FBBB',
          canvas_markdown: '# Notes 2'
        }
      ])
    )
    const huddles = await new FileSlackSource(path).list()
    expect(huddles).toHaveLength(2)
    expect(huddles[0].fileId).toBe('F4567WXYZ')
    expect(huddles[0].channelName).toBe('core-values')
    expect(huddles[0].huddleDate).toBe('2026-04-11T16:00:00Z')
    expect(huddles[0].canvasMarkdown).toContain('Decided X')
    // Second huddle has no explicit huddle_date — derived from message_ts
    expect(huddles[1].huddleDate).toMatch(/^2024-04-/) // ts converted to ISO
  })

  it('reads the messages+canvases shape and joins on file_id', async () => {
    const path = join(tmpDir, 'h.json')
    writeFileSync(
      path,
      JSON.stringify({
        messages: [
          {
            user: 'USLACKBOT',
            ts: '1714098000.000400',
            text:
              'AI huddle notes are ready. ' +
              '<https://projcaribou.slack.com/docs/T0123ABCD/F4567WXYZ|View AI Notes>',
            channel: { id: 'C1', name: 'core-values' }
          },
          // Should be filtered out (not USLACKBOT)
          {
            user: 'U_HUMAN',
            ts: '1714098000.999',
            text: 'AI huddle notes are ready (impersonator)',
            channel: { id: 'C1', name: 'core-values' }
          },
          // Should be filtered out (no docs link)
          {
            user: 'USLACKBOT',
            ts: '1714098001.000',
            text: 'AI huddle notes are ready (no link)',
            channel: { id: 'C1', name: 'core-values' }
          }
        ],
        canvases: {
          F4567WXYZ: '# Huddle 1\nNotes here.'
        }
      })
    )
    const huddles = await new FileSlackSource(path).list()
    expect(huddles).toHaveLength(1)
    expect(huddles[0].fileId).toBe('F4567WXYZ')
    expect(huddles[0].teamId).toBe('T0123ABCD')
    expect(huddles[0].channelName).toBe('core-values')
    expect(huddles[0].canvasMarkdown).toContain('Huddle 1')
  })

  it('skips messages whose canvas is missing in the canvases map', async () => {
    const path = join(tmpDir, 'h.json')
    writeFileSync(
      path,
      JSON.stringify({
        messages: [
          {
            user: 'USLACKBOT',
            ts: '1714098000',
            text: 'AI huddle notes are ready: https://x.slack.com/docs/T1/F_MISSING',
            channel: { id: 'C1', name: 'general' }
          }
        ],
        canvases: {} // empty
      })
    )
    const huddles = await new FileSlackSource(path).list()
    expect(huddles).toHaveLength(0)
  })

  it('throws on missing file', async () => {
    await expect(
      new FileSlackSource(join(tmpDir, 'nope.json')).list()
    ).rejects.toThrow(/not found/)
  })

  it('throws when a pre-resolved huddle is missing required fields', async () => {
    const path = join(tmpDir, 'h.json')
    writeFileSync(
      path,
      JSON.stringify([{ channel_id: 'C1', channel_name: 'foo' }]) // missing rest
    )
    await expect(new FileSlackSource(path).list()).rejects.toThrow(/required/)
  })

  it('throws on top-level shape that is neither array nor messages-object', async () => {
    const path = join(tmpDir, 'h.json')
    writeFileSync(path, JSON.stringify({ not: 'a recognized shape' }))
    await expect(new FileSlackSource(path).list()).rejects.toThrow(/array|messages/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// LiveSlackSource — failed canvas fetch graceful degradation
// ─────────────────────────────────────────────────────────────────────────

describe('LiveSlackSource', () => {
  it('returns huddles for matching messages and joins canvas markdown', async () => {
    const messages = [
      {
        user: 'USLACKBOT',
        ts: '1714098000',
        text:
          'AI huddle notes are ready. ' +
          '<https://projcaribou.slack.com/docs/T0/FGOOD123|View AI Notes>',
        channel: { id: 'C1', name: 'core-values' }
      }
    ]
    const src = new LiveSlackSource(
      {
        searchPublic: async () => ({ messages }),
        readCanvas: async (id: string) => {
          if (id === 'FGOOD123') return { canvas_markdown: '# good notes' }
          throw new Error('not found')
        }
      },
      { searchQuery: 'q', searchLimit: 10 }
    )
    const huddles = await src.list()
    expect(huddles).toHaveLength(1)
    expect(huddles[0].canvasMarkdown).toBe('# good notes')
  })

  it('skips a huddle when readCanvas throws (does not blow up the batch)', async () => {
    const messages = [
      {
        user: 'USLACKBOT',
        ts: '1714098000',
        text: 'AI huddle notes are ready: https://x.slack.com/docs/T0/FGOOD',
        channel: { id: 'C1', name: 'core-values' }
      },
      {
        user: 'USLACKBOT',
        ts: '1714098001',
        text: 'AI huddle notes are ready: https://x.slack.com/docs/T0/FBAD',
        channel: { id: 'C1', name: 'core-values' }
      }
    ]
    const src = new LiveSlackSource(
      {
        searchPublic: async () => ({ messages }),
        readCanvas: async (id: string) => {
          if (id === 'FGOOD') return '# ok'
          throw new Error('canvas not accessible')
        }
      },
      { searchQuery: 'q', searchLimit: 10 }
    )
    const huddles = await src.list()
    expect(huddles).toHaveLength(1)
    expect(huddles[0].fileId).toBe('FGOOD')
  })

  it('accepts both string and object canvas results', async () => {
    const messages = [
      {
        user: 'USLACKBOT',
        ts: '1',
        text: 'AI huddle notes are ready: https://x.slack.com/docs/T/F1',
        channel: { id: 'C1', name: 'one' }
      },
      {
        user: 'USLACKBOT',
        ts: '2',
        text: 'AI huddle notes are ready: https://x.slack.com/docs/T/F2',
        channel: { id: 'C1', name: 'one' }
      }
    ]
    const src = new LiveSlackSource(
      {
        searchPublic: async () => ({ messages }),
        readCanvas: async (id: string) =>
          id === 'F1' ? '# string form' : { canvas_markdown: '# obj form' }
      },
      { searchQuery: 'q', searchLimit: 10 }
    )
    const huddles = await src.list()
    expect(huddles).toHaveLength(2)
    expect(huddles[0].canvasMarkdown).toBe('# string form')
    expect(huddles[1].canvasMarkdown).toBe('# obj form')
  })

  it('skips messages that do not pass the Slackbot recap filter', async () => {
    const messages = [
      {
        user: 'U_HUMAN',
        ts: '1',
        text: 'AI huddle notes are ready (impersonator): https://x.slack.com/docs/T/F1',
        channel: { id: 'C1', name: 'one' }
      },
      {
        user: 'USLACKBOT',
        ts: '2',
        text: 'totally different Slackbot announcement',
        channel: { id: 'C1', name: 'one' }
      }
    ]
    const src = new LiveSlackSource(
      {
        searchPublic: async () => ({ messages }),
        readCanvas: async () => '# unused'
      },
      { searchQuery: 'q', searchLimit: 10 }
    )
    const huddles = await src.list()
    expect(huddles).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// processHuddle + runImport — wired to fakes
// ─────────────────────────────────────────────────────────────────────────

class FakeSource implements SlackHuddleSource {
  constructor(private huddles: RawHuddle[]) {}
  async list() {
    return this.huddles
  }
}

class FakeDistiller implements DistillerLike {
  constructor(
    private overrides: Partial<DistilledHuddle> = {},
    private throwOn?: string
  ) {}
  async distill(huddle: RawHuddle): Promise<DistilledHuddle> {
    if (this.throwOn && huddle.fileId === this.throwOn) {
      throw new Error('haiku exploded')
    }
    return {
      summary: this.overrides.summary ?? `summary for ${huddle.fileId}`,
      claims: this.overrides.claims ?? [
        {
          type: 'decision',
          content: 'A decision.',
          qualitative_confidence: 'firm',
          topics: [],
          people: []
        },
        {
          type: 'context',
          content: 'A context.',
          qualitative_confidence: 'tentative',
          topics: [],
          people: []
        }
      ]
    }
  }
}

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
    return {
      success: true,
      id: `kms-id-${++this.idCounter}`,
      storageDecision: { primary: 'graph', secondary: ['mem0'], reasoning: 'fake' }
    }
  }

  async initialize() {
    /* noop */
  }
  async close() {
    /* noop */
  }
}

function mkHuddle(over: Partial<RawHuddle> = {}): RawHuddle {
  return {
    channelId: 'C1',
    channelName: 'core-values',
    messageTs: '1714098000.000400',
    teamId: 'T0',
    fileId: over.fileId ?? 'FX',
    huddleDate: '2026-04-11T16:00:00Z',
    canvasMarkdown: '# canvas\nnotes',
    ...over
  }
}

function defaultOpts(): any {
  return {
    source: 'file',
    searchQuery: DEFAULT_SEARCH_QUERY,
    searchLimit: 20,
    kmsUrl: 'http://localhost:8180/mcp',
    syncLogPath: '/tmp/test-sync.json',
    userId: 'test-user',
    anthropicModel: 'claude-haiku-4-5',
    workspace: 'tengo',
    dryRun: true
  }
}

describe('processHuddle', () => {
  it('skips a huddle already in the sync log', async () => {
    const h = mkHuddle({ fileId: 'F-old' })
    const result = await processHuddle(h, {
      source: new FakeSource([]),
      distiller: new FakeDistiller(),
      kms: new FakeMcpClient() as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: ['F-old'] }
    })
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('sync log')
  })

  it('writes summary + N claim entries on the happy path', async () => {
    const h = mkHuddle({ fileId: 'F-new' })
    const kms = new FakeMcpClient()
    const result = await processHuddle(h, {
      source: new FakeSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('ok')
    expect(result.summaryEntryId).toBe('kms-id-1')
    expect(result.claimEntryIds).toEqual(['kms-id-2', 'kms-id-3'])

    expect(kms.calls).toHaveLength(3) // 1 summary + 2 claims
    const [summary, claim0, claim1] = kms.calls
    expect(summary.name).toBe('unified_store')
    expect(summary.args.contentType).toBe('memory')
    expect(summary.args.metadata.subject).toBe('Slack.huddle.core-values.2026-04-11')
    expect(summary.args.metadata.source).toBe('slack_huddle')
    expect(summary.args.metadata.source_doc).toBe('slack://canvas/T0/F-new')
    expect(summary.args.metadata.slack_workspace).toBe('tengo')
    expect(summary.args.metadata.slack_channel).toBe('C1')
    expect(summary.args.metadata.slack_message_ts).toBe('1714098000.000400')
    expect(summary.args.metadata.slack_canvas_id).toBe('F-new')
    expect(summary.args.metadata.huddle_date).toBe('2026-04-11T16:00:00Z')

    expect(claim0.args.metadata.related_to).toEqual(['kms-id-1'])
    expect(claim0.args.metadata.source_doc).toBe('slack://canvas/T0/F-new')
    expect(claim0.args.metadata.subject).toBe('Slack.huddle.core-values.2026-04-11.claim_0')
    expect(claim0.args.contentType).toBe('insight') // decision → insight
    expect(claim0.args.metadata.qualitative_confidence).toBe('firm')
    expect(claim1.args.contentType).toBe('memory') // context → memory
  })

  it('handles dedup_required on summary write — counts as dedup_refused, not failed', async () => {
    const h = mkHuddle({ fileId: 'F-dup' })
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
    const result = await processHuddle(h, {
      source: new FakeSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('dedup_refused')
    expect(result.candidates?.[0]?.id).toBe('existing-1')
    // We did NOT proceed to write claims when summary refused
    expect(kms.calls).toHaveLength(1)
  })

  it('handles distillation failure (failed, with reason)', async () => {
    const h = mkHuddle({ fileId: 'F-bad' })
    const kms = new FakeMcpClient()
    const result = await processHuddle(h, {
      source: new FakeSource([]),
      distiller: new FakeDistiller({}, 'F-bad'),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('haiku exploded')
    expect(kms.calls).toHaveLength(0)
  })

  it('continues past a single claim failure (counts huddle as ok if summary landed)', async () => {
    const h = mkHuddle({ fileId: 'F-mixed' })
    const kms = new FakeMcpClient([
      // 1: summary success
      { success: true, id: 'sum-1' },
      // 2: claim 0 success
      { success: true, id: 'claim-0' },
      // 3: claim 1 dedup_refused (non-fatal)
      { status: 'dedup_required', candidates: [{ id: 'existing' }], message: 'dup' }
    ])
    const result = await processHuddle(h, {
      source: new FakeSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('ok')
    expect(result.summaryEntryId).toBe('sum-1')
    expect(result.claimEntryIds).toEqual(['claim-0'])
  })

  it('dry-run path skips KMS calls entirely', async () => {
    const h = mkHuddle({ fileId: 'F-dry' })
    const kms = new FakeMcpClient()
    const result = await processHuddle(h, {
      source: new FakeSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: true },
      log: { completed: [] }
    })
    expect(result.status).toBe('ok')
    expect(kms.calls).toHaveLength(0)
  })

  it('routes the supersede/dedup chain only on summary — claim dedup is non-fatal', async () => {
    const h = mkHuddle({ fileId: 'F-mixed-2' })
    // 1 summary ok, 1 claim ok, 1 claim throws (e.g. KMS down briefly), 0 more claims
    // (but distiller returns 2 claims by default)
    const kms = new FakeMcpClient([
      { success: true, id: 'sum-1' },
      { success: true, id: 'claim-0' },
      // simulate a real throw on the second claim — e.g. transient HTTP
    ])
    // Replace callTool to throw on the third call
    let n = 0
    const origCall = kms.callTool.bind(kms)
    kms.callTool = async (name: string, args: any) => {
      n++
      if (n === 3) throw new Error('transient HTTP')
      return origCall(name, args)
    }
    const result = await processHuddle(h, {
      source: new FakeSource([]),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts: { ...defaultOpts(), dryRun: false },
      log: { completed: [] }
    })
    expect(result.status).toBe('ok') // summary landed
    expect(result.summaryEntryId).toBe('sum-1')
    expect(result.claimEntryIds).toEqual(['claim-0'])
  })
})

describe('runImport', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slack-runimport-test-'))
    logPath = join(tmpDir, '.kms-slack-huddle-sync.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rolls forward across mixed outcomes (skipped + ok + dedup_refused + failed)', async () => {
    const huddles = [
      mkHuddle({ fileId: 'F-skip', channelName: 'one' }),
      mkHuddle({ fileId: 'F-ok', channelName: 'two' }),
      mkHuddle({ fileId: 'F-dedup', channelName: 'three' }),
      mkHuddle({ fileId: 'F-fail', channelName: 'four' })
    ]
    const kms = new FakeMcpClient([
      // F-ok: summary + 2 claims
      { success: true, id: 'sum-ok' },
      { success: true, id: 'claim-0' },
      { success: true, id: 'claim-1' },
      // F-dedup: summary returns dedup_required
      { status: 'dedup_required', candidates: [{ id: 'existing' }], message: 'dup' }
      // F-fail: distiller throws — no KMS calls
    ])

    const opts = { ...defaultOpts(), syncLogPath: logPath, dryRun: false }
    const log = { completed: ['F-skip'] }

    const report = await runImport({
      source: new FakeSource(huddles),
      distiller: new FakeDistiller({}, 'F-fail'),
      kms: kms as any,
      opts,
      log
    })

    expect(report.totalHuddles).toBe(4)
    expect(report.summaries).toBe(1)
    expect(report.claims).toBe(2)
    expect(report.skipped).toEqual([{ fileId: 'F-skip', channel: 'one' }])
    expect(report.dedupRefused).toHaveLength(1)
    expect(report.dedupRefused[0].fileId).toBe('F-dedup')
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].fileId).toBe('F-fail')

    // Sync log persisted with the new ok'd id
    const saved = JSON.parse(readFileSync(logPath, 'utf-8'))
    expect(saved.completed).toContain('F-skip')
    expect(saved.completed).toContain('F-ok')
    expect(saved.completed).not.toContain('F-fail')
    expect(saved.completed).not.toContain('F-dedup')
  })

  it('respects --max-huddles cap', async () => {
    const huddles = Array.from({ length: 10 }, (_, i) =>
      mkHuddle({ fileId: `F_${i}`, channelName: `c${i}` })
    )
    const kms = new FakeMcpClient()
    const opts = {
      ...defaultOpts(),
      syncLogPath: logPath,
      maxHuddles: 3,
      dryRun: false
    }
    const log = { completed: [] }
    const report = await runImport({
      source: new FakeSource(huddles),
      distiller: new FakeDistiller(),
      kms: kms as any,
      opts,
      log
    })
    expect(report.totalHuddles).toBe(3)
    expect(report.summaries).toBe(3)
    expect(report.claims).toBe(6)
  })

  it('survives a per-huddle distiller error (does not blow up sibling huddles)', async () => {
    const huddles = [
      mkHuddle({ fileId: 'a', channelName: 'A' }),
      mkHuddle({ fileId: 'b', channelName: 'B' }),
      mkHuddle({ fileId: 'c', channelName: 'C' })
    ]
    const kms = new FakeMcpClient()
    const report = await runImport({
      source: new FakeSource(huddles),
      distiller: new FakeDistiller({}, 'b'),
      kms: kms as any,
      opts: { ...defaultOpts(), syncLogPath: logPath, dryRun: false },
      log: { completed: [] }
    })
    expect(report.summaries).toBe(2)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].fileId).toBe('b')
  })

  it('persists sync log incrementally — one ok then crash mid-run leaves first id committed', async () => {
    const huddles = [
      mkHuddle({ fileId: 'first', channelName: 'A' }),
      mkHuddle({ fileId: 'crash', channelName: 'B' })
    ]
    const kms = new FakeMcpClient()
    // Distiller throws on second huddle — first should still be persisted
    const report = await runImport({
      source: new FakeSource(huddles),
      distiller: new FakeDistiller({}, 'crash'),
      kms: kms as any,
      opts: { ...defaultOpts(), syncLogPath: logPath, dryRun: false },
      log: { completed: [] }
    })
    expect(report.summaries).toBe(1)
    expect(report.failed).toHaveLength(1)
    const saved = JSON.parse(readFileSync(logPath, 'utf-8'))
    expect(saved.completed).toEqual(['first'])
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
