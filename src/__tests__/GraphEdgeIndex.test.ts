/**
 * GraphEdgeIndex — the relationship read path for the SparrowDB graph backend.
 *
 * Regression cover for `unified_search` returning `relationships: []` on graph
 * hits. The previous reader issued, per hit, one RELATED_TO query plus one
 * ABOUT query for each of six hard-coded entity labels, so:
 *
 *   - only 2 of the graph's ~45 relationship types were ever read back. Every
 *     typed edge `unified_store` writes (SOLVES, REQUIRES, SUPERSEDES,
 *     IMPLEMENTS, …) went into the graph and never came out of it.
 *   - only OUTGOING edges were followed, so an entry that other entries point
 *     at — which is what `_createSemanticRelationships` produces, since it
 *     links new → existing — reported no relationships at all.
 *   - SparrowDB ignores a label predicate naming a label with no nodes, so the
 *     six-label ABOUT loop returned each entity two or three times.
 *   - `strength` was hard-coded null even where the edge property is readable.
 *
 * The fake binding below mirrors the real one's quirks that matter here:
 * `RETURN type(r)` is not distinct, and endpoint ids can read back null.
 */

import {
  GraphEdgeIndex,
  decodeStrength,
  DEFAULT_MAX_RELATIONSHIPS_PER_NODE,
  type EdgeQueryExecutor
} from '../storage/GraphEdgeIndex.js'

type Edge = { from: string | null; type: string; to: string | null; strength?: number | null }

interface FakeDbOptions {
  /** Make `MATCH ()-[r]->() RETURN type(r)` throw, forcing the fallback type list. */
  breakTypeDiscovery?: boolean
  /** Make the `r.strength` projection throw, forcing the no-strength retry. */
  breakStrengthProjection?: boolean
  /** Make every query throw, simulating an unreadable graph. */
  breakEverything?: boolean
}

class FakeDb implements EdgeQueryExecutor {
  readonly queries: string[] = []

  constructor(private edges: Edge[], private opts: FakeDbOptions = {}) {}

  execute(cypher: string) {
    this.queries.push(cypher)
    if (this.opts.breakEverything) throw new Error('database is closed')

    if (/RETURN type\(r\) AS rel/.test(cypher)) {
      if (this.opts.breakTypeDiscovery) throw new Error('type(r) unsupported on this build')
      // Deliberately NOT distinct — the real binding returns one row per edge.
      return { columns: ['rel'], rows: this.edges.map(e => ({ rel: e.type })) }
    }

    const withStrength = cypher.match(
      /^MATCH \(a\)-\[r:([A-Za-z0-9_]+)\]->\(b\) RETURN a\.id, b\.id, r\.strength$/
    )
    if (withStrength) {
      if (this.opts.breakStrengthProjection) throw new Error('edge property projection unsupported')
      return {
        columns: ['a.id', 'b.id', 'r.strength'],
        rows: this.matching(withStrength[1]).map(e => ({
          'a.id': e.from,
          'b.id': e.to,
          'r.strength': e.strength ?? null
        }))
      }
    }

    const noStrength = cypher.match(/^MATCH \(a\)-\[:([A-Za-z0-9_]+)\]->\(b\) RETURN a\.id, b\.id$/)
    if (noStrength) {
      return {
        columns: ['a.id', 'b.id'],
        rows: this.matching(noStrength[1]).map(e => ({ 'a.id': e.from, 'b.id': e.to }))
      }
    }

    throw new Error(`FakeDb received an unexpected query: ${cypher}`)
  }

  private matching(type: string): Edge[] {
    return this.edges.filter(e => e.type === type)
  }
}

const CONTENTS: Record<string, string> = {
  'k-1': 'Ollama timeout budgets widened for a LAN Ollama',
  'k-2': 'Ollama request budget spec',
  'k-3': 'Retry policy for unreachable inference hosts',
  richard_yaker: 'Richard Yaker'
}

function resolver(contents: Record<string, string> = CONTENTS) {
  return (id: string) => (contents[id] === undefined ? undefined : { id, content: contents[id] })
}

function makeIndex(edges: Edge[], opts?: FakeDbOptions, contents?: Record<string, string>) {
  const db = new FakeDb(edges, opts)
  return { db, index: new GraphEdgeIndex(db, resolver(contents)) }
}

describe('GraphEdgeIndex — relationship reads', () => {
  it('returns typed edges, not just RELATED_TO and ABOUT', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'SOLVES', to: 'k-2', strength: 100 },
      { from: 'k-1', type: 'SUPERSEDES', to: 'k-3', strength: 80 },
      { from: 'k-1', type: 'RELATED_TO', to: 'k-2' },
      { from: 'k-1', type: 'ABOUT', to: 'richard_yaker' }
    ])

    const rels = index.relationshipsFor('k-1')

    expect(rels.map(r => r.relationship).sort()).toEqual([
      'ABOUT',
      'RELATED_TO',
      'SOLVES',
      'SUPERSEDES'
    ])
    expect(rels.every(r => r.direction === 'outgoing')).toBe(true)
  })

  it('includes inbound edges so a node that is only ever a target is not reported as unconnected', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'RELATED_TO', to: 'k-2' },
      { from: 'k-3', type: 'REFINES', to: 'k-2' }
    ])

    // k-2 has no outgoing edges at all — the old reader returned [] for it.
    const rels = index.relationshipsFor('k-2')

    expect(rels).toHaveLength(2)
    expect(rels.every(r => r.direction === 'incoming')).toBe(true)
    expect(rels.map(r => r.relatedNode).sort()).toEqual(['k-1', 'k-3'])
  })

  it('orders outgoing before incoming and labels each with its direction', () => {
    const { index } = makeIndex([
      { from: 'k-2', type: 'RELATED_TO', to: 'k-1' },
      { from: 'k-1', type: 'SOLVES', to: 'k-3' }
    ])

    expect(index.relationshipsFor('k-1').map(r => [r.relationship, r.direction])).toEqual([
      ['SOLVES', 'outgoing'],
      ['RELATED_TO', 'incoming']
    ])
  })

  it('decodes the 0-100 integer strength back into 0-1 and leaves absent strength null', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'SOLVES', to: 'k-2', strength: 100 },
      { from: 'k-1', type: 'REFINES', to: 'k-3', strength: 80 },
      { from: 'k-1', type: 'ABOUT', to: 'richard_yaker', strength: null }
    ])

    const byType = Object.fromEntries(
      index.relationshipsFor('k-1').map(r => [r.relationship, r.strength])
    )

    expect(byType.SOLVES).toBe(1)
    expect(byType.REFINES).toBeCloseTo(0.8)
    expect(byType.ABOUT).toBeNull()
  })

  it('resolves related content from the sidecar and falls back to the raw id', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'ABOUT', to: 'richard_yaker' },
      { from: 'k-1', type: 'ABOUT', to: 'not-in-sidecar' }
    ])

    const rels = index.relationshipsFor('k-1')

    expect(rels[0]).toMatchObject({ relatedNode: 'richard_yaker', relatedContent: 'Richard Yaker' })
    expect(rels[1]).toMatchObject({ relatedNode: 'not-in-sidecar', relatedContent: '' })
  })

  it('collapses parallel edges of the same type between the same pair', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'ABOUT', to: 'richard_yaker' },
      { from: 'k-1', type: 'ABOUT', to: 'richard_yaker' },
      { from: 'k-1', type: 'ABOUT', to: 'richard_yaker' }
    ])

    expect(index.relationshipsFor('k-1')).toHaveLength(1)
  })

  it('keeps the same pair when the edges differ by type or direction', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'SOLVES', to: 'k-2' },
      { from: 'k-1', type: 'REFINES', to: 'k-2' },
      { from: 'k-2', type: 'SOLVES', to: 'k-1' }
    ])

    expect(index.relationshipsFor('k-1')).toHaveLength(3)
  })

  it('caps the relationships returned for a hub node', () => {
    const edges: Edge[] = []
    const contents: Record<string, string> = { hub: 'hub node' }
    for (let i = 0; i < 200; i++) {
      edges.push({ from: `n-${i}`, type: 'ABOUT', to: 'hub' })
      contents[`n-${i}`] = `entry ${i}`
    }
    const { index } = makeIndex(edges, undefined, contents)

    expect(index.relationshipsFor('hub')).toHaveLength(DEFAULT_MAX_RELATIONSHIPS_PER_NODE)
  })

  it('skips edges whose endpoint id reads back null', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'RELATED_TO', to: null },
      { from: null, type: 'RELATED_TO', to: 'k-1' },
      { from: 'k-1', type: 'SOLVES', to: 'k-2' }
    ])

    const rels = index.relationshipsFor('k-1')

    expect(rels).toHaveLength(1)
    expect(rels[0].relationship).toBe('SOLVES')
  })

  it('returns [] for a node with no edges', () => {
    const { index } = makeIndex([{ from: 'k-1', type: 'SOLVES', to: 'k-2' }])

    expect(index.relationshipsFor('k-3')).toEqual([])
  })
})

describe('GraphEdgeIndex — degraded bindings', () => {
  it('de-duplicates the non-distinct type(r) result', () => {
    const { db, index } = makeIndex([
      { from: 'k-1', type: 'RELATED_TO', to: 'k-2' },
      { from: 'k-1', type: 'RELATED_TO', to: 'k-3' },
      { from: 'k-2', type: 'SOLVES', to: 'k-3' }
    ])

    expect(index.discoverRelationshipTypes().sort()).toEqual(['RELATED_TO', 'SOLVES'])

    index.build()
    // One edge query per distinct type, not per edge.
    expect(db.queries.filter(q => q.startsWith('MATCH (a)'))).toHaveLength(2)
  })

  it('rejects a relationship type that is not a bare identifier', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'RELATED_TO', to: 'k-2' },
      { from: 'k-1', type: 'BAD]->() DELETE (x', to: 'k-3' }
    ])

    expect(index.discoverRelationshipTypes()).toEqual(['RELATED_TO'])
  })

  it('falls back to the known type list when type(r) discovery is unsupported', () => {
    const { index } = makeIndex(
      [
        { from: 'k-1', type: 'RELATED_TO', to: 'k-2' },
        { from: 'k-1', type: 'SOLVES', to: 'k-3' }
      ],
      { breakTypeDiscovery: true }
    )

    // SOLVES is unreachable without discovery, but the reader must not fail closed.
    expect(index.relationshipsFor('k-1').map(r => r.relationship)).toEqual(['RELATED_TO'])
  })

  it('retries without the strength projection when the binding rejects edge properties', () => {
    const { index } = makeIndex(
      [{ from: 'k-1', type: 'SOLVES', to: 'k-2', strength: 100 }],
      { breakStrengthProjection: true }
    )

    const rels = index.relationshipsFor('k-1')

    expect(rels).toHaveLength(1)
    expect(rels[0].strength).toBeNull()
  })

  it('returns [] rather than throwing when the graph is unreadable', () => {
    const { index } = makeIndex([{ from: 'k-1', type: 'SOLVES', to: 'k-2' }], {
      breakEverything: true
    })

    expect(index.relationshipsFor('k-1')).toEqual([])
  })
})

describe('GraphEdgeIndex — lifecycle', () => {
  it('builds once and serves later reads from memory', () => {
    const { db, index } = makeIndex([{ from: 'k-1', type: 'RELATED_TO', to: 'k-2' }])

    index.relationshipsFor('k-1')
    const afterFirst = db.queries.length
    expect(afterFirst).toBeGreaterThan(0)
    expect(index.isBuilt).toBe(true)

    index.relationshipsFor('k-1')
    index.relationshipsFor('k-2')

    expect(db.queries.length).toBe(afterFirst)
  })

  it('picks up an edge added after the build without rescanning the graph', () => {
    const { db, index } = makeIndex([])

    expect(index.relationshipsFor('k-1')).toEqual([])
    const afterBuild = db.queries.length

    index.addEdge('k-1', 'k-2', 'SOLVES', 0.9)

    expect(index.relationshipsFor('k-1')).toEqual([
      {
        relationship: 'SOLVES',
        relatedNode: 'k-2',
        relatedContent: 'Ollama request budget spec',
        direction: 'outgoing',
        strength: 0.9
      }
    ])
    // Visible from the other end too, and no re-scan.
    expect(index.relationshipsFor('k-2')[0].direction).toBe('incoming')
    expect(db.queries.length).toBe(afterBuild)
  })

  it('ignores addEdge before the index is built, so the build still sees the truth', () => {
    const { index } = makeIndex([{ from: 'k-1', type: 'SOLVES', to: 'k-2' }])

    index.addEdge('k-1', 'k-3', 'REFINES', 1)

    // Not double-counted: the build reads the graph, which is the source of truth.
    expect(index.relationshipsFor('k-1').map(r => r.relationship)).toEqual(['SOLVES'])
  })

  it('drops both sides of every edge when a node is removed', () => {
    const { index } = makeIndex([
      { from: 'k-1', type: 'RELATED_TO', to: 'k-2' },
      { from: 'k-3', type: 'REFINES', to: 'k-1' },
      { from: 'k-3', type: 'SOLVES', to: 'k-2' }
    ])

    expect(index.relationshipsFor('k-1')).toHaveLength(2)

    index.removeNode('k-1')

    expect(index.relationshipsFor('k-1')).toEqual([])
    expect(index.relationshipsFor('k-2').map(r => r.relatedNode)).toEqual(['k-3'])
    expect(index.relationshipsFor('k-3').map(r => r.relatedNode)).toEqual(['k-2'])
  })

  it('rebuilds after a reset', () => {
    const { db, index } = makeIndex([{ from: 'k-1', type: 'RELATED_TO', to: 'k-2' }])

    index.relationshipsFor('k-1')
    const afterFirst = db.queries.length

    index.reset()
    expect(index.isBuilt).toBe(false)

    expect(index.relationshipsFor('k-1')).toHaveLength(1)
    expect(db.queries.length).toBeGreaterThan(afterFirst)
  })
})

describe('decodeStrength', () => {
  it.each([
    [100, 1],
    [80, 0.8],
    [0, 0]
  ])('maps the stored integer %p to %p', (raw, expected) => {
    expect(decodeStrength(raw)).toBeCloseTo(expected)
  })

  it('clamps values outside the stored range', () => {
    expect(decodeStrength(400)).toBe(1)
    expect(decodeStrength(-50)).toBe(0)
  })

  it.each([null, undefined, 'not a number', NaN])('returns null for %p', raw => {
    expect(decodeStrength(raw)).toBeNull()
  })
})
