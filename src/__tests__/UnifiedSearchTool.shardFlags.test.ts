/**
 * Mem0 fan-out shards must inherit their parent KMS entry's flag.
 *
 * Background (measured 2026-08-01): every `unified_store` write is fanned out by
 * Mem0's LLM extractor into several "User described…" rows, each a separate
 * searchable entry carrying `metadata.kms_id` back to the KMS entry it came from.
 * Mem0 has no flag concept, so `kms_supersede` / `kms_delete` flagged the graph and
 * MongoDB copies and left every shard live and retrievable. Three freshly-flagged
 * parents still had 11 shards surfacing in the top-15 across six real queries.
 *
 * That made the documented guarantee — that superseding a fact stops it leaking into
 * future context injection — false for the highest-volume backend. These tests pin
 * the read-time join that fixes it, and equally pin the cases where a shard must be
 * KEPT, because over-filtering silently deletes live knowledge and is the worse bug.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'

type Entry = { id: string; flag?: string | null }

const makeTool = (graphEntries: Entry[], mem0Results: any[], opts: { throwOnLookup?: boolean; noFindById?: boolean } = {}) => {
  const byId = new Map(graphEntries.map(e => [e.id, e]))
  const graph: any = {}
  if (!opts.noFindById) {
    graph.findById = (id: string) => {
      if (opts.throwOnLookup) throw new Error('backend unavailable')
      return byId.get(id) ?? null
    }
  }
  const mem0: any = { search: async () => mem0Results }
  return new UnifiedSearchTool({ mongodb: {} as any, graph, mem0 }, null)
}

const search = (tool: UnifiedSearchTool, options: any = {}) =>
  (tool as any).searchMem0({ query: 'q', options })

const shard = (id: string, kms_id?: string) => ({ id, content: `shard ${id}`, metadata: kms_id ? { kms_id } : {} })

describe('Mem0 shards inherit the parent entry flag', () => {
  it('drops shards whose parent is flagged SUPERSEDED', async () => {
    const tool = makeTool(
      [{ id: 'parent-1', flag: 'SUPERSEDED' }, { id: 'parent-2', flag: null }],
      [shard('s1', 'parent-1'), shard('s2', 'parent-2')]
    )
    const out = await search(tool)
    expect(out.map((r: any) => r.id)).toEqual(['s2'])
  })

  it('drops shards whose parent is flagged DELETED', async () => {
    const tool = makeTool([{ id: 'p', flag: 'DELETED' }], [shard('s1', 'p')])
    expect(await search(tool)).toHaveLength(0)
  })

  it('drops every shard of one flagged parent, not just the first', async () => {
    // The real failure was multi-shard: one supersede produced five live copies.
    const tool = makeTool(
      [{ id: 'p', flag: 'RETRACTED' }],
      [shard('s1', 'p'), shard('s2', 'p'), shard('s3', 'p')]
    )
    expect(await search(tool)).toHaveLength(0)
  })

  it('keeps shards when includeFlagged is set (audit path)', async () => {
    const tool = makeTool([{ id: 'p', flag: 'SUPERSEDED' }], [shard('s1', 'p')])
    expect(await search(tool, { includeFlagged: true })).toHaveLength(1)
  })
})

describe('shards that must NOT be dropped', () => {
  it('keeps a shard with no kms_id — nothing to inherit', async () => {
    const tool = makeTool([{ id: 'p', flag: 'DELETED' }], [shard('s1')])
    expect(await search(tool)).toHaveLength(1)
  })

  it('keeps a shard whose parent is unknown to the graph', async () => {
    // findById returns null for Mem0-only entries that never reached the graph.
    // An unknown parent is not evidence of retraction.
    const tool = makeTool([], [shard('s1', 'never-seen')])
    expect(await search(tool)).toHaveLength(1)
  })

  it('keeps a shard whose parent exists and is unflagged', async () => {
    const tool = makeTool([{ id: 'p', flag: null }], [shard('s1', 'p')])
    expect(await search(tool)).toHaveLength(1)
  })

  it('keeps a self-referential row where kms_id equals its own id', async () => {
    const tool = makeTool([{ id: 's1', flag: null }], [shard('s1', 's1')])
    expect(await search(tool)).toHaveLength(1)
  })

  it('keeps everything when the graph backend cannot answer lookups', async () => {
    // A backend that throws must degrade to "show the results", never to a silent
    // blanket drop of the Mem0 tier.
    const tool = makeTool([{ id: 'p', flag: 'DELETED' }], [shard('s1', 'p')], { throwOnLookup: true })
    expect(await search(tool)).toHaveLength(1)
  })

  it('keeps everything when the graph backend has no findById at all', async () => {
    const tool = makeTool([], [shard('s1', 'p')], { noFindById: true })
    expect(await search(tool)).toHaveLength(1)
  })

  it('handles a null/blank metadata object without throwing', async () => {
    const tool = makeTool([{ id: 'p', flag: 'DELETED' }], [{ id: 's1', content: 'x' }, { id: 's2', content: 'y', metadata: null }])
    expect(await search(tool)).toHaveLength(2)
  })
})

describe('lookup efficiency', () => {
  it('looks each distinct parent up once regardless of shard count', async () => {
    // One supersede can produce many shards; an uncached lookup per shard would put
    // a graph read on every Mem0 row of every search.
    let calls = 0
    const graph: any = { findById: (id: string) => { calls++; return { id, flag: null } } }
    const mem0: any = { search: async () => [shard('s1', 'p'), shard('s2', 'p'), shard('s3', 'p'), shard('s4', 'other')] }
    const tool = new UnifiedSearchTool({ mongodb: {} as any, graph, mem0 }, null)
    await (tool as any).searchMem0({ query: 'q', options: {} })
    expect(calls).toBe(2)
  })
})
