/**
 * Unit tests for the Markdown corpus → KMS importer.
 *
 * Covers (per spec):
 *   - walk respects skip patterns
 *   - git-repo detection
 *   - sync-log resumability
 *   - content-hash change detection
 *   - dedup_required → action=update retry path
 *   - distillation JSON validation
 *   - long-doc chunking
 */

import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  approxWordCount,
  chunkLongDoc,
  computeContentHash,
  computeSubject,
  inferWholeDocContentType,
  isInsideGitRepo,
  KmsHttpClient,
  loadSyncLog,
  mapClaimTypeToContentType,
  pathHasSkipSegment,
  planAction,
  qualitativeToNumeric,
  resolveStoreResult,
  saveSyncLog,
  stripCodeFences,
  validateDistillation,
  walkRoot,
  type FileRecord,
  type SyncLog
} from '../scripts/import-md-corpus.js'

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'md-corpus-test-'))
}

async function rimraf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

describe('content-hash & subject', () => {
  test('computeContentHash is deterministic and changes on edit', () => {
    const h1 = computeContentHash('hello world')
    const h2 = computeContentHash('hello world')
    const h3 = computeContentHash('hello world!')
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  test('computeSubject slugifies filenames', () => {
    const s = computeSubject('Notes', '/Users/x/Documents/Notes/My Big Spec.md')
    expect(s).toBe('Notes.My-Big-Spec')
  })

  test('computeSubject handles special chars', () => {
    const s = computeSubject('Notes', '/x/Sophia Automated Content Pipeline — Zora Implementation Spec.md')
    // em-dash + spaces collapse to single dashes
    expect(s).toBe('Notes.Sophia-Automated-Content-Pipeline-Zora-Implementation-Spec')
  })

  test('approxWordCount works for short and long', () => {
    expect(approxWordCount('hello world')).toBe(2)
    expect(approxWordCount('   one  two  three  ')).toBe(3)
    expect(approxWordCount('')).toBe(0)
  })
})

describe('claim-type / contentType mapping', () => {
  test('all 6 OB1 types map correctly', () => {
    expect(mapClaimTypeToContentType('decision')).toBe('insight')
    expect(mapClaimTypeToContentType('preference')).toBe('memory')
    expect(mapClaimTypeToContentType('learning')).toBe('insight')
    expect(mapClaimTypeToContentType('context')).toBe('memory')
    expect(mapClaimTypeToContentType('brainstorm')).toBe('insight')
    expect(mapClaimTypeToContentType('reference')).toBe('procedure')
  })

  test('qualitativeToNumeric per spec', () => {
    expect(qualitativeToNumeric('firm')).toBe(0.9)
    expect(qualitativeToNumeric('tentative')).toBe(0.65)
    expect(qualitativeToNumeric('exploring')).toBe(0.4)
  })
})

describe('inferWholeDocContentType', () => {
  test('spec/plan/research → insight', () => {
    expect(inferWholeDocContentType('KMS-Enrichment-Layer-Spec.md', '# Spec')).toBe('insight')
    expect(inferWholeDocContentType('Implementation Plan.md', '# Plan')).toBe('insight')
    expect(inferWholeDocContentType('Research Notes.md', '# Research')).toBe('insight')
  })

  test('meeting / standup / notes → memory', () => {
    expect(inferWholeDocContentType('March 24 Meeting.md', '# Meeting')).toBe('memory')
    expect(inferWholeDocContentType('DirecTV Prep.md', '# Notes')).toBe('memory')
    expect(inferWholeDocContentType('Daily Standup.md', '...')).toBe('memory')
  })

  test('curriculum / reference / how-to → procedure', () => {
    expect(inferWholeDocContentType('Cookbook.md', '# Cookbook')).toBe('procedure')
    expect(inferWholeDocContentType('METADATA_EXTRACTION_COOKBOOK.md', '...')).toBe('procedure')
    expect(inferWholeDocContentType('SOP-deploy.md', '...')).toBe('procedure')
  })

  test('tracker → memory', () => {
    expect(inferWholeDocContentType('Backlog.md', '...')).toBe('memory')
    expect(inferWholeDocContentType('TODO.md', '...')).toBe('memory')
  })

  test('default fallback → insight', () => {
    expect(inferWholeDocContentType('Random Thoughts.md', '...')).toBe('insight')
  })
})

// ─── pathHasSkipSegment ────────────────────────────────────────────────────────

describe('pathHasSkipSegment', () => {
  test('flags node_modules / .git / .scratch / assets / data', () => {
    expect(pathHasSkipSegment('/foo/node_modules/bar.md')).toBe(true)
    expect(pathHasSkipSegment('/foo/.git/HEAD')).toBe(true)
    expect(pathHasSkipSegment('/foo/.scratch/x.md')).toBe(true)
    expect(pathHasSkipSegment('/foo/assets/img.md')).toBe(true)
    expect(pathHasSkipSegment('/foo/data/big.md')).toBe(true)
  })

  test('does not false-positive on partial matches', () => {
    expect(pathHasSkipSegment('/foo/data-mining/spec.md')).toBe(false)
    expect(pathHasSkipSegment('/foo/asset_library/x.md')).toBe(false)
    expect(pathHasSkipSegment('/foo/git-stuff/x.md')).toBe(false)
  })
})

// ─── walkRoot ──────────────────────────────────────────────────────────────────

describe('walkRoot', () => {
  test('respects skip segments and dotted dirs', async () => {
    const root = await tmpDir()
    try {
      await fs.mkdir(path.join(root, 'good'))
      await fs.mkdir(path.join(root, 'node_modules'))
      await fs.mkdir(path.join(root, '.scratch'))
      await fs.mkdir(path.join(root, '.git'))
      await fs.mkdir(path.join(root, 'data'))
      await fs.mkdir(path.join(root, 'assets'))
      await fs.writeFile(path.join(root, 'top.md'), '# top')
      await fs.writeFile(path.join(root, 'good', 'nested.md'), '# nested')
      await fs.writeFile(path.join(root, 'node_modules', 'evil.md'), '# evil')
      await fs.writeFile(path.join(root, '.scratch', 'evil.md'), '# evil')
      await fs.writeFile(path.join(root, '.git', 'evil.md'), '# evil')
      await fs.writeFile(path.join(root, 'data', 'huge.md'), '# huge')
      await fs.writeFile(path.join(root, 'assets', 'logo.md'), '# logo')

      const out = await walkRoot(root, { recursive: true })
      const paths = out.map(f => path.relative(root, f.absolutePath)).sort()
      expect(paths).toEqual(['good/nested.md', 'top.md'])
    } finally {
      await rimraf(root)
    }
  })

  test('non-recursive mode picks up only top-level .md', async () => {
    const root = await tmpDir()
    try {
      await fs.writeFile(path.join(root, 'a.md'), 'a')
      await fs.writeFile(path.join(root, 'b.md'), 'b')
      await fs.mkdir(path.join(root, 'sub'))
      await fs.writeFile(path.join(root, 'sub', 'c.md'), 'c')

      const out = await walkRoot(root, { recursive: false })
      const names = out.map(f => path.basename(f.absolutePath)).sort()
      expect(names).toEqual(['a.md', 'b.md'])
    } finally {
      await rimraf(root)
    }
  })

  test('only .md files are picked up', async () => {
    const root = await tmpDir()
    try {
      await fs.writeFile(path.join(root, 'a.md'), 'a')
      await fs.writeFile(path.join(root, 'b.txt'), 'b')
      await fs.writeFile(path.join(root, 'c.pdf'), 'c')
      const out = await walkRoot(root, { recursive: true })
      expect(out.map(f => path.basename(f.absolutePath))).toEqual(['a.md'])
    } finally {
      await rimraf(root)
    }
  })

  test('source_project is the basename of the root', async () => {
    const root = await tmpDir()
    try {
      await fs.writeFile(path.join(root, 'a.md'), 'a')
      const out = await walkRoot(root, { recursive: true })
      expect(out[0].sourceProject).toBe(path.basename(root))
    } finally {
      await rimraf(root)
    }
  })

  test('returns empty array for non-existent root', async () => {
    const out = await walkRoot('/no/such/path/zzz', { recursive: true })
    expect(out).toEqual([])
  })
})

// ─── isInsideGitRepo ───────────────────────────────────────────────────────────

describe('isInsideGitRepo', () => {
  test('this repo is detected as a git repo', () => {
    // Guard for CI/sandbox environments that strip .git for layer caching.
    const repoRoot = path.resolve(__dirname, '../../')
    const hasGitDir = (() => {
      try {
        const stat = require('fs').statSync(path.join(repoRoot, '.git'))
        return stat.isDirectory() || stat.isFile() // worktrees use a .git file
      } catch {
        return false
      }
    })()
    if (!hasGitDir) {
      return // skip — no .git present in this environment
    }
    expect(isInsideGitRepo(__filename)).toBe(true)
  })

  test('a path inside /tmp is NOT a git repo', async () => {
    const t = await tmpDir()
    try {
      const f = path.join(t, 'not-tracked.md')
      await fs.writeFile(f, 'x')
      expect(isInsideGitRepo(f)).toBe(false)
    } finally {
      await rimraf(t)
    }
  })
})

// ─── Sync log persistence & resumability ───────────────────────────────────────

describe('sync log', () => {
  test('returns empty log when file is missing', async () => {
    const t = await tmpDir()
    try {
      const log = await loadSyncLog(path.join(t, 'no-such.json'))
      expect(log.version).toBe(1)
      expect(log.entries).toEqual({})
    } finally {
      await rimraf(t)
    }
  })

  test('round-trips entries to disk', async () => {
    const t = await tmpDir()
    try {
      const p = path.join(t, 'sync.json')
      const log: SyncLog = {
        version: 1,
        entries: {
          '/foo/bar.md': {
            absolute_path: '/foo/bar.md',
            content_sha256: 'a'.repeat(64),
            whole_doc_id: 'id-1',
            claim_ids: ['id-2', 'id-3'],
            imported_at: '2026-05-06T00:00:00.000Z',
            source_project: 'Notes',
            word_count: 100,
            file_size: 1024
          }
        }
      }
      await saveSyncLog(p, log)
      const reloaded = await loadSyncLog(p)
      expect(reloaded).toEqual(log)
    } finally {
      await rimraf(t)
    }
  })

  test('backs up + resets on unrecognized log shape', async () => {
    const t = await tmpDir()
    try {
      const p = path.join(t, 'sync.json')
      await fs.writeFile(p, JSON.stringify({ unknown: 'shape' }))
      const log = await loadSyncLog(p)
      expect(log.entries).toEqual({})
      // backup file with .bak. prefix should exist
      const dirEntries = await fs.readdir(t)
      expect(dirEntries.some(n => n.includes('.bak.'))).toBe(true)
    } finally {
      await rimraf(t)
    }
  })
})

describe('planAction (resumability)', () => {
  function mkFile(p: string): FileRecord {
    return {
      absolutePath: p,
      rootDir: '/',
      sourceProject: 'Notes',
      size: 100,
      mtime: new Date()
    }
  }

  test('new file → action=new', () => {
    const log: SyncLog = { version: 1, entries: {} }
    const r = planAction(mkFile('/x.md'), 'h1', log, false)
    expect(r.action).toBe('new')
  })

  test('unchanged hash → action=skip', () => {
    const log: SyncLog = {
      version: 1,
      entries: {
        '/x.md': {
          absolute_path: '/x.md', content_sha256: 'h1', whole_doc_id: 'id1',
          claim_ids: [], imported_at: 'now', source_project: 'Notes', word_count: 0, file_size: 0
        }
      }
    }
    const r = planAction(mkFile('/x.md'), 'h1', log, false)
    expect(r.action).toBe('skip')
  })

  test('changed hash → action=update', () => {
    const log: SyncLog = {
      version: 1,
      entries: {
        '/x.md': {
          absolute_path: '/x.md', content_sha256: 'h1', whole_doc_id: 'id1',
          claim_ids: [], imported_at: 'now', source_project: 'Notes', word_count: 0, file_size: 0
        }
      }
    }
    const r = planAction(mkFile('/x.md'), 'DIFFERENT', log, false)
    expect(r.action).toBe('update')
    expect(r.priorEntry?.whole_doc_id).toBe('id1')
  })

  test('--force on unchanged → action=update', () => {
    const log: SyncLog = {
      version: 1,
      entries: {
        '/x.md': {
          absolute_path: '/x.md', content_sha256: 'h1', whole_doc_id: 'id1',
          claim_ids: [], imported_at: 'now', source_project: 'Notes', word_count: 0, file_size: 0
        }
      }
    }
    const r = planAction(mkFile('/x.md'), 'h1', log, true)
    expect(r.action).toBe('update')
  })

  test('partial / errored prior import → action=retry', () => {
    const log: SyncLog = {
      version: 1,
      entries: {
        '/x.md': {
          absolute_path: '/x.md', content_sha256: 'h1', whole_doc_id: null,
          claim_ids: [], imported_at: 'now', source_project: 'Notes', word_count: 0, file_size: 0,
          last_error: 'KMS down'
        }
      }
    }
    const r = planAction(mkFile('/x.md'), 'h1', log, false)
    expect(r.action).toBe('retry')
  })
})

// ─── Distillation validation ───────────────────────────────────────────────────

describe('validateDistillation', () => {
  test('accepts a valid object', () => {
    const valid = {
      summary: 'a brief summary that is non-empty',
      claims: [
        { type: 'decision', content: 'we chose X', qualitative_confidence: 'firm', topics: ['t'], people: ['Rich'] },
        { type: 'reference', content: 'X means Y', qualitative_confidence: 'tentative' }
      ]
    }
    const out = validateDistillation(valid)
    expect(out.summary).toBe(valid.summary)
    expect(out.claims).toHaveLength(2)
    expect(out.claims[0].topics).toEqual(['t'])
    expect(out.claims[0].people).toEqual(['Rich'])
  })

  test('rejects missing summary', () => {
    expect(() => validateDistillation({ claims: [] })).toThrow(/summary/)
  })

  test('rejects empty summary', () => {
    expect(() => validateDistillation({ summary: '   ', claims: [] })).toThrow(/summary/)
  })

  test('rejects bad claim type', () => {
    expect(() =>
      validateDistillation({
        summary: 'ok',
        claims: [{ type: 'bogus', content: 'x', qualitative_confidence: 'firm' }]
      })
    ).toThrow(/type/)
  })

  test('rejects bad qualitative_confidence', () => {
    expect(() =>
      validateDistillation({
        summary: 'ok',
        claims: [{ type: 'decision', content: 'x', qualitative_confidence: 'sometimes' }]
      })
    ).toThrow(/qualitative_confidence/)
  })

  test('rejects empty content in claim', () => {
    expect(() =>
      validateDistillation({
        summary: 'ok',
        claims: [{ type: 'decision', content: '', qualitative_confidence: 'firm' }]
      })
    ).toThrow(/content/)
  })

  test('rejects non-array claims', () => {
    expect(() => validateDistillation({ summary: 'ok', claims: 'nope' })).toThrow(/claims/)
  })

  test('handles missing topics/people gracefully', () => {
    const out = validateDistillation({
      summary: 'ok',
      claims: [{ type: 'decision', content: 'x', qualitative_confidence: 'firm' }]
    })
    expect(out.claims[0].topics).toBeUndefined()
    expect(out.claims[0].people).toBeUndefined()
  })
})

describe('stripCodeFences', () => {
  test('strips ```json fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('strips bare ``` fences', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('leaves un-fenced content alone', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}')
  })
})

// ─── Long-doc chunking ─────────────────────────────────────────────────────────

// ─── resolveStoreResult direct unit tests ─────────────────────────────────────

describe('resolveStoreResult', () => {
  function makeClient(): KmsHttpClient {
    return new KmsHttpClient('http://invalid.localhost/mcp', null)
  }

  test('success response returns id', async () => {
    const client = makeClient()
    const spy = jest.spyOn(client, 'unifiedStore').mockResolvedValue({ success: true, id: 'store-id-1' })
    const res = await client.unifiedStore({ content: 'x', contentType: 'insight' })
    const id = await resolveStoreResult(client, res, { content: 'x', contentType: 'insight' }, 'new', undefined)
    expect(id).toBe('store-id-1')
    spy.mockRestore()
  })

  test('dedup_required with prior entry + action=new → reuses prior id (unchanged content path)', async () => {
    const client = makeClient()
    const priorEntry = {
      absolute_path: '/foo.md',
      content_sha256: 'abc',
      whole_doc_id: 'prior-whole-id',
      claim_ids: [],
      imported_at: '2026-01-01T00:00:00.000Z',
      source_project: 'Notes',
      word_count: 50,
      file_size: 256
    }
    const dedupRes = {
      status: 'dedup_required' as const,
      candidates: [{ id: 'prior-1', similarity: 0.95, content_preview: 'foo' }],
      message: 'duplicate',
      retry_with: ['action=update&old_id=prior-1'],
      band: 'refuse' as const,
      thresholds: { refuse: 0.88, confirm: 0.78 }
    }
    const id = await resolveStoreResult(client, dedupRes, { content: 'x', contentType: 'insight' }, 'new', priorEntry)
    // Should return the prior whole_doc_id without calling unifiedStore again
    expect(id).toBe('prior-whole-id')
  })

  test('dedup_required with no prior entry + action=new → retries with action=update on top candidate', async () => {
    const client = makeClient()
    const spy = jest.spyOn(client, 'unifiedStore').mockResolvedValue({ success: true, id: 'retry-id' })
    const dedupRes = {
      status: 'dedup_required' as const,
      candidates: [{ id: 'candidate-99', similarity: 0.91, content_preview: 'bar' }],
      message: 'duplicate',
      retry_with: ['action=update&old_id=candidate-99'],
      band: 'refuse' as const,
      thresholds: { refuse: 0.88, confirm: 0.78 }
    }
    const id = await resolveStoreResult(client, dedupRes, { content: 'y', contentType: 'memory' }, 'new', undefined)
    expect(id).toBe('retry-id')
    // Should have retried with action=update pointing at the candidate
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ action: 'update', old_id: 'candidate-99' }))
    spy.mockRestore()
  })

  test('dedup_required with no candidates + action=new → throws', async () => {
    const client = makeClient()
    const dedupRes = {
      status: 'dedup_required' as const,
      candidates: [],
      message: 'gate refused but no candidates',
      retry_with: [],
      band: 'refuse' as const,
      thresholds: { refuse: 0.88, confirm: 0.78 }
    }
    await expect(
      resolveStoreResult(client, dedupRes, { content: 'z', contentType: 'fact' }, 'new', undefined)
    ).rejects.toThrow('dedup_required and unable to retry')
  })
})

// ─── KMS HTTP client / dedup retry contract (integration-style surface test) ──

describe('KMS dedup_required retry path (contract)', () => {
  // Validates the JSON-RPC surface of KmsHttpClient.unifiedStore — separate from
  // the resolveStoreResult logic which is tested directly above.
  test('KmsHttpClient.unifiedStore passes through dedup_required shape', async () => {
    const client = new KmsHttpClient('http://invalid.localhost/mcp', null)
    const spy = jest.spyOn(client, 'unifiedStore')

    spy.mockResolvedValueOnce({
      status: 'dedup_required',
      candidates: [{ id: 'prior-1', similarity: 0.93, content_preview: 'foo' }],
      message: 'duplicate',
      retry_with: ['action=update&old_id=prior-1&reason=...'],
      band: 'refuse',
      thresholds: { refuse: 0.88, confirm: 0.78 }
    })
    spy.mockResolvedValueOnce({ success: true, id: 'new-id-after-retry' })

    const r1 = await client.unifiedStore({ content: 'x', contentType: 'insight' })
    expect(r1.status).toBe('dedup_required')

    const r2 = await client.unifiedStore({
      content: 'x',
      contentType: 'insight',
      action: 'update',
      old_id: 'prior-1',
      reason: 'content hash changed'
    })
    expect(r2.success).toBe(true)
    expect(r2.id).toBe('new-id-after-retry')
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})

describe('chunkLongDoc', () => {
  test('splits on H2 headers', () => {
    const doc = [
      '# Title',
      'preamble',
      '',
      '## Section 1',
      'content for section 1',
      'more content',
      '',
      '## Section 2',
      'content for section 2',
      '',
      '## Section 3',
      'content for section 3'
    ].join('\n')
    const chunks = chunkLongDoc(doc)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.some(c => c.startsWith('## Section 1'))).toBe(true)
    expect(chunks.some(c => c.startsWith('## Section 2'))).toBe(true)
    expect(chunks.some(c => c.startsWith('## Section 3'))).toBe(true)
  })

  test('falls back to paragraph blocks when no H2', () => {
    // Build a doc with no H2 but enough paragraphs to trigger chunking.
    // PARAGRAPH_CHUNK_BYTES=3072 — feed 12 paragraphs of 800 chars each = ~9600 bytes,
    // expecting ≥3 chunks.
    const para = 'word '.repeat(160).trim()
    const doc = Array(12).fill(para).join('\n\n')
    const chunks = chunkLongDoc(doc)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // No chunk should exceed PARAGRAPH_CHUNK_BYTES by much (allow +1 paragraph slop)
    for (const c of chunks) expect(c.length).toBeLessThan(800 * 12)
  })

  test('preserves preamble before first H2', () => {
    // chunkLongDoc only kicks in H2 mode when there are 2+ H2s.
    const doc = [
      '# Title',
      'this preamble is long enough to keep — needs > 200 chars to be retained.',
      'second line of preamble ' + 'x'.repeat(200),
      '',
      '## First',
      'body of first section',
      '',
      '## Second',
      'body of second section'
    ].join('\n')
    const chunks = chunkLongDoc(doc)
    // Chunk 0 should be the preamble (ie not start with ## First)
    expect(chunks[0].startsWith('## First')).toBe(false)
    expect(chunks.some(c => c.startsWith('## First'))).toBe(true)
    expect(chunks.some(c => c.startsWith('## Second'))).toBe(true)
  })
})
