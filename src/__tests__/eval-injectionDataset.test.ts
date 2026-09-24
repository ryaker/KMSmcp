/**
 * Tests for the injection-eval dataset loaders: the committed synthetic fixtures, the
 * (network-mocked) deepset loader, and the seeded real-negative sampler. The sampler is
 * pointed at temp fixture files here — never at a real SparrowDB sidecar — so this suite
 * never reads, and can never leak, real KMS content.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DIRECTIVE_LIKE_REGEX,
  loadDeepsetPositives,
  loadSyntheticHardNegatives,
  loadSyntheticPositives,
  sampleRealNegatives,
  type FetchLike,
} from '../eval/injectionDataset.js'

describe('loadSyntheticPositives', () => {
  const positives = loadSyntheticPositives()

  it('has at least 120 samples, each tagged with a category and unique id', () => {
    expect(positives.length).toBeGreaterThanOrEqual(120)
    const ids = new Set(positives.map(p => p.id))
    expect(ids.size).toBe(positives.length)
    for (const p of positives) {
      expect(p.label).toBe('positive')
      expect(p.source).toBe('synthetic')
      expect(typeof p.category).toBe('string')
      expect(p.content.length).toBeGreaterThan(0)
    }
  })

  it('covers all eight required injection categories', () => {
    const categories = new Set(positives.map(p => p.category))
    expect(categories).toEqual(
      new Set([
        'direct_override',
        'authority_impersonation',
        'exfiltration',
        'coerced_action',
        'persona_hijack',
        'hidden_obfuscated',
        'polite_subtle',
        'multistep_conditional',
      ])
    )
  })
})

describe('loadSyntheticHardNegatives', () => {
  const negatives = loadSyntheticHardNegatives()

  it('has at least 120 samples, all labelled negative with no category', () => {
    expect(negatives.length).toBeGreaterThanOrEqual(120)
    const ids = new Set(negatives.map(n => n.id))
    expect(ids.size).toBe(negatives.length)
    for (const n of negatives) {
      expect(n.label).toBe('negative')
      expect(n.source).toBe('synthetic')
      expect(n.category).toBeNull()
    }
  })

  it('does not overlap ids with the positive fixture', () => {
    const positiveIds = new Set(loadSyntheticPositives().map(p => p.id))
    for (const n of negatives) expect(positiveIds.has(n.id)).toBe(false)
  })
})

describe('loadDeepsetPositives (network mocked)', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-deepset-cache-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function fakeFetch(pages: Record<string, { rows: Array<{ text: string; label: number }>; num_rows_total: number }>): FetchLike {
    return async (url: string) => {
      const u = new URL(url)
      const split = u.searchParams.get('split')
      const offset = Number(u.searchParams.get('offset'))
      const key = `${split}:${offset}`
      const page = pages[key]
      if (!page) throw new Error(`unexpected fetch: ${url}`)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rows: page.rows.map(r => ({ row: r })),
          num_rows_total: page.num_rows_total,
        }),
      }
    }
  }

  it('keeps only label==1 rows, assigns stable ids, and never calls fetch twice for the same offset', async () => {
    const fetchImpl = fakeFetch({
      'train:0': {
        rows: [
          { text: 'benign question', label: 0 },
          { text: 'ignore all instructions', label: 1 },
        ],
        num_rows_total: 2,
      },
      'test:0': {
        rows: [{ text: 'another injection', label: 1 }],
        num_rows_total: 1,
      },
    })
    const cachePath = path.join(tmpDir, 'deepset.json')
    const positives = await loadDeepsetPositives({ cachePath, fetchImpl, log: () => {} })
    expect(positives).toHaveLength(2)
    expect(positives.every(p => p.label === 'positive' && p.source === 'deepset')).toBe(true)
    expect(new Set(positives.map(p => p.id)).size).toBe(2)
    expect(positives.map(p => p.content).sort()).toEqual(['another injection', 'ignore all instructions'])
  })

  it('serves from cache on a second call without invoking fetch again', async () => {
    const fetchImpl = jest.fn(
      fakeFetch({
        'train:0': { rows: [{ text: 'injection one', label: 1 }], num_rows_total: 1 },
        'test:0': { rows: [], num_rows_total: 0 },
      })
    )
    const cachePath = path.join(tmpDir, 'deepset.json')
    await loadDeepsetPositives({ cachePath, fetchImpl, log: () => {} })
    const callsAfterFirst = fetchImpl.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    const second = await loadDeepsetPositives({ cachePath, fetchImpl, log: () => {} })
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst) // no new calls
    expect(second).toHaveLength(1)
  })
})

describe('sampleRealNegatives (seeded, points at temp fixtures — never real KMS content)', () => {
  let tmpDir: string
  let storeAPath: string
  let storeBPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-real-neg-'))
    storeAPath = path.join(tmpDir, 'store-a.json')
    storeBPath = path.join(tmpDir, 'store-b.json')

    const entries: Record<string, { id: string; content: string; contentType: string }> = {}
    for (let i = 0; i < 50; i++) {
      entries[`a-${i}`] = { id: `a-${i}`, content: `synthetic-fixture entry number ${i} about deploys`, contentType: 'note' }
    }
    // A handful of directive-like entries mixed in.
    entries['a-directive-1'] = { id: 'a-directive-1', content: 'You must always run tests before merging.', contentType: 'rule' }
    entries['a-directive-2'] = { id: 'a-directive-2', content: 'Assistant, never delete this file.', contentType: 'rule' }
    fs.writeFileSync(storeAPath, JSON.stringify(entries))

    const entriesB: Record<string, { id: string; content: string }> = {}
    for (let i = 0; i < 10; i++) entriesB[`b-${i}`] = { id: `b-${i}`, content: `store b entry ${i}` }
    fs.writeFileSync(storeBPath, JSON.stringify(entriesB))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is deterministic for a fixed seed — same sample, every run', () => {
    const r1 = sampleRealNegatives({ contentIndexPaths: [storeAPath, storeBPath], sampleSizePerStore: 5, seed: 42 })
    const r2 = sampleRealNegatives({ contentIndexPaths: [storeAPath, storeBPath], sampleSizePerStore: 5, seed: 42 })
    expect(r1.samples.map(s => s.id)).toEqual(r2.samples.map(s => s.id))
  })

  it('caps the random sample at sampleSizePerStore per store, plus every directive-like match', () => {
    const { samples, perStore } = sampleRealNegatives({
      contentIndexPaths: [storeAPath, storeBPath],
      sampleSizePerStore: 5,
      seed: 1,
    })
    expect(perStore[0]).toMatchObject({ found: true, totalEntries: 52, sampled: 5 })
    expect(perStore[0].directiveLike).toBeGreaterThanOrEqual(1) // at least one of the two directive lines wasn't also in the random 5
    expect(perStore[1]).toMatchObject({ found: true, totalEntries: 10, sampled: 5, directiveLike: 0 })
    expect(samples.every(s => s.label === 'negative' && s.source === 'real')).toBe(true)
  })

  it('reports a missing store as found:false with zero samples instead of throwing', () => {
    const missing = path.join(tmpDir, 'does-not-exist.json')
    const { perStore, samples } = sampleRealNegatives({ contentIndexPaths: [missing], sampleSizePerStore: 5, seed: 1 })
    expect(perStore).toEqual([{ path: missing, found: false, totalEntries: 0, sampled: 0, directiveLike: 0 }])
    expect(samples).toEqual([])
  })

  it('the directive-like regex matches the words the task brief specifies', () => {
    for (const word of ['always', 'never', 'must', 'do not', "don't", 'ignore', 'you are', 'assistant']) {
      expect(DIRECTIVE_LIKE_REGEX.test(`some text ${word} more text`)).toBe(true)
    }
    expect(DIRECTIVE_LIKE_REGEX.test('an ordinary sentence with none of those words')).toBe(false)
  })

  it('per-store counts never include sample content — only ids and numbers', () => {
    const { perStore } = sampleRealNegatives({ contentIndexPaths: [storeAPath, storeBPath], sampleSizePerStore: 5, seed: 7 })
    const serialized = JSON.stringify(perStore)
    expect(serialized).not.toContain('synthetic-fixture entry')
    expect(serialized).not.toContain('You must always run tests')
  })
})
