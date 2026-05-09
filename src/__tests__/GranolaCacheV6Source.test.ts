/**
 * Tests for GranolaCacheV6Source — the autonomous source that reads
 * transcripts directly from the Granola desktop app's on-disk cache.
 *
 * Coverage:
 *   - Lists meetings from a fixture cache
 *   - Filters by `since` (and merges with watermark)
 *   - Watermark persists and skips on next run
 *   - Skips deleted / non-meeting / malformed documents gracefully (no throw)
 *   - Handles missing keys / missing file / unreadable JSON without crashing
 *   - assembleTranscript groups same-source segments and skips non-final/empty
 */

import {
  GranolaCacheV6Source,
  loadWatermark,
  saveWatermark,
  assembleTranscript,
  CacheV6Watermark
} from '../scripts/granola-cache-v6-source.js'

import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'granola-cache-v6.fixture.json')

describe('GranolaCacheV6Source — fixture cache', () => {
  let tmpDir: string
  let cachePath: string
  let wmPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'granola-cache-v6-'))
    cachePath = join(tmpDir, 'cache-v6.json')
    wmPath = join(tmpDir, 'state.json')
    copyFileSync(FIXTURE_PATH, cachePath)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists every importable meeting from the fixture (3 of 7 documents)', async () => {
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: wmPath,
      ignoreWatermark: true
    })
    const meetings = await src.list()

    // Three importable: doc-old-001, doc-mid-002, doc-new-003.
    // Skipped: deleted-004, no-transcript-005, scratchpad-006, malformed-007.
    expect(meetings).toHaveLength(3)
    const ids = meetings.map(m => m.id)
    expect(ids).toEqual(['doc-old-001', 'doc-mid-002', 'doc-new-003'])
  })

  it('emits the canonical RawMeeting shape (id/title/date/transcript)', async () => {
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: wmPath,
      ignoreWatermark: true
    })
    const [first] = await src.list()
    expect(first.id).toBe('doc-old-001')
    expect(first.title).toBe('Q1 retro — synthetic test data')
    expect(first.date).toBe('2026-01-10T15:00:00.000Z')
    expect(first.transcript).toContain('[Microphone]')
    expect(first.transcript).toContain('[System]')
    // Welcome…review on the same speaker should be joined into one line.
    expect(first.transcript).toContain('Welcome everyone to the Q1 retro. Lets review what shipped.')
  })

  it('skips non-final and empty transcript segments', async () => {
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: wmPath,
      ignoreWatermark: true
    })
    const [first] = await src.list()
    // The fixture's doc-old-001 has a non-final segment and an empty-text
    // segment — neither should appear in the assembled transcript.
    expect(first.transcript).not.toContain('non-final')
    // Empty segment had only whitespace; nothing to assert positively beyond
    // "the assembled string didn't gain a stray empty line"
    expect(first.transcript.split('\n').every(l => l.trim().length > 0)).toBe(true)
  })

  it('filters by `since` (drops meetings whose end-ts is earlier)', async () => {
    const since = new Date('2026-04-01T00:00:00Z')
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: wmPath,
      ignoreWatermark: true,
      since
    })
    const meetings = await src.list()
    // Only doc-new-003 has end-ts (2026-05-01T16:30Z) after the since floor.
    // doc-old-001 ends 2026-01-10, doc-mid-002 ends 2026-03-15 → both dropped.
    expect(meetings.map(m => m.id)).toEqual(['doc-new-003'])
  })

  it('merges since-filter with watermark (later one wins)', async () => {
    // Watermark is mid-March — later than the explicit early-March since.
    saveWatermark(wmPath, {
      lastSeenEndTs: '2026-03-20T00:00:00.000Z',
      lastImportedIds: []
    })
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: wmPath,
      since: new Date('2026-01-01T00:00:00Z')
    })
    const meetings = await src.list()
    // Only doc-new-003 (2026-05-01) clears the watermark.
    expect(meetings.map(m => m.id)).toEqual(['doc-new-003'])
  })

  it('explicit since wins when it is later than the watermark', async () => {
    saveWatermark(wmPath, {
      lastSeenEndTs: '2026-01-01T00:00:00.000Z',
      lastImportedIds: []
    })
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: wmPath,
      since: new Date('2026-04-01T00:00:00Z')
    })
    const meetings = await src.list()
    expect(meetings.map(m => m.id)).toEqual(['doc-new-003'])
  })

  it('markImported persists watermark — next run skips already-emitted meetings', async () => {
    const first = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: wmPath,
      ignoreWatermark: true
    })
    const meetings1 = await first.list()
    expect(meetings1).toHaveLength(3)

    // Mark all as imported in oldest-first order
    for (const m of meetings1) first.markImported(m.id)

    // Watermark file should now reflect the latest end-ts
    expect(existsSync(wmPath)).toBe(true)
    const wm = JSON.parse(readFileSync(wmPath, 'utf-8'))
    expect(wm.lastSeenEndTs).toBe('2026-05-01T16:30:00.000Z')
    expect(wm.lastImportedIds).toEqual(['doc-old-001', 'doc-mid-002', 'doc-new-003'])

    // Construct a fresh source — it should pick up the watermark and emit
    // nothing new.
    const second = new GranolaCacheV6Source({ cachePath, watermarkPath: wmPath })
    const meetings2 = await second.list()
    expect(meetings2).toHaveLength(0)
  })

  it('markImported only advances the watermark forward', async () => {
    saveWatermark(wmPath, {
      lastSeenEndTs: '2026-12-31T00:00:00.000Z',
      lastImportedIds: []
    })
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: wmPath,
      // bypass watermark-as-floor for this test by ignoring it, then re-load.
      ignoreWatermark: true
    })
    // Re-load watermark manually so markImported sees the future timestamp
    // (we want to assert markImported won't roll it back).
    ;(src as any).watermark = loadWatermark(wmPath)
    const meetings = await src.list()
    expect(meetings.length).toBeGreaterThan(0)
    src.markImported(meetings[0].id)
    const wm = JSON.parse(readFileSync(wmPath, 'utf-8'))
    expect(wm.lastSeenEndTs).toBe('2026-12-31T00:00:00.000Z')
  })
})

describe('GranolaCacheV6Source — defensive paths', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'granola-cache-v6-defensive-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('throws a clear error when the cache file is missing', async () => {
    const src = new GranolaCacheV6Source({
      cachePath: join(tmpDir, 'nope.json'),
      watermarkPath: join(tmpDir, 'state.json'),
      ignoreWatermark: true
    })
    await expect(src.list()).rejects.toThrow(/not found/)
  })

  it('returns [] (no throw) when the cache JSON is mid-write / corrupted', async () => {
    const cachePath = join(tmpDir, 'cache-v6.json')
    writeFileSync(cachePath, '{ "cache": { "version": 6, "state": { "doc')  // truncated
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: join(tmpDir, 'state.json'),
      ignoreWatermark: true
    })
    const out = await src.list()
    expect(out).toEqual([])
  })

  it('returns [] when cache.state is missing (schema drift)', async () => {
    const cachePath = join(tmpDir, 'cache-v6.json')
    writeFileSync(cachePath, JSON.stringify({ cache: { version: 7 } }))
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: join(tmpDir, 'state.json'),
      ignoreWatermark: true
    })
    const out = await src.list()
    expect(out).toEqual([])
  })

  it('returns [] when transcripts key is absent', async () => {
    const cachePath = join(tmpDir, 'cache-v6.json')
    writeFileSync(cachePath, JSON.stringify({
      cache: { version: 6, state: { documents: { 'a': { id: 'a', type: 'meeting', title: 'x' } } } }
    }))
    const src = new GranolaCacheV6Source({
      cachePath,
      watermarkPath: join(tmpDir, 'state.json'),
      ignoreWatermark: true
    })
    const out = await src.list()
    expect(out).toEqual([])
  })
})

describe('watermark file IO', () => {
  let tmpDir: string
  let wmPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'granola-wm-'))
    wmPath = join(tmpDir, 'state.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns a default watermark when the file does not exist', () => {
    const wm = loadWatermark(wmPath)
    expect(wm).toEqual({ lastImportedIds: [] })
  })

  it('returns a default watermark on malformed JSON (no throw)', () => {
    writeFileSync(wmPath, 'not json')
    const wm = loadWatermark(wmPath)
    expect(wm).toEqual({ lastImportedIds: [] })
  })

  it('round-trips lastSeenEndTs + lastImportedIds', () => {
    const original: CacheV6Watermark = {
      lastSeenEndTs: '2026-04-01T00:00:00.000Z',
      lastImportedIds: ['a', 'b', 'c']
    }
    saveWatermark(wmPath, original)
    const restored = loadWatermark(wmPath)
    expect(restored).toEqual(original)
  })

  it('caps lastImportedIds tail at 200', () => {
    const big: CacheV6Watermark = {
      lastSeenEndTs: '2026-04-01T00:00:00.000Z',
      lastImportedIds: Array.from({ length: 500 }, (_, i) => `id-${i}`)
    }
    saveWatermark(wmPath, big)
    const restored = loadWatermark(wmPath)
    expect(restored.lastImportedIds).toHaveLength(200)
    // Keeps the tail (most-recent), not the head
    expect(restored.lastImportedIds[0]).toBe('id-300')
    expect(restored.lastImportedIds[199]).toBe('id-499')
  })
})

describe('assembleTranscript', () => {
  it('joins adjacent same-source segments into one line', () => {
    const segs = [
      { text: 'Hello,',    source: 'microphone', is_final: true },
      { text: 'how are',   source: 'microphone', is_final: true },
      { text: 'you?',      source: 'microphone', is_final: true },
      { text: 'Im fine.',  source: 'system',     is_final: true },
      { text: 'Thanks.',   source: 'system',     is_final: true }
    ]
    const out = assembleTranscript(segs)
    expect(out).toBe('[Microphone] Hello, how are you?\n[System] Im fine. Thanks.')
  })

  it('skips non-final and empty/whitespace segments', () => {
    const segs = [
      { text: 'real',   source: 'microphone', is_final: true },
      { text: 'partial', source: 'microphone', is_final: false },
      { text: '   ',    source: 'microphone', is_final: true },
      { text: 'more real', source: 'system',  is_final: true }
    ]
    const out = assembleTranscript(segs)
    expect(out).toBe('[Microphone] real\n[System] more real')
  })

  it('returns empty string for empty/missing input', () => {
    expect(assembleTranscript([])).toBe('')
    expect(assembleTranscript(null as any)).toBe('')
    expect(assembleTranscript(undefined as any)).toBe('')
  })

  it('labels unknown sources verbatim and "Unknown" for missing', () => {
    const segs = [
      { text: 'a', source: 'phone',      is_final: true },
      { text: 'b', source: undefined,    is_final: true },
      { text: 'c', source: '',           is_final: true }
    ]
    const out = assembleTranscript(segs)
    // 'phone' kept; '' and undefined → 'Unknown'.
    expect(out).toContain('[phone] a')
    expect(out).toContain('[Unknown]')
  })
})
