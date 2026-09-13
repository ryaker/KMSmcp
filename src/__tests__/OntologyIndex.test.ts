/**
 * OntologyIndex — entity retrieval over the SparrowDB ontology.
 *
 * Regression cover for `unified_search` looking empty on people. `SparrowDBStorage.search`
 * scored the Knowledge content sidecar and stamped every hit `nodeLabels: ['Knowledge']`,
 * so:
 *
 *   - "Tell me about my dad" never reached the Person node `charles_yaker`, which is in
 *     the graph with `relationship: father` and a `PARENT_OF` edge to Richard.
 *   - `UnifiedSearchTool.expandWithEntityContext` gates on entity labels, so with every
 *     hit labelled `Knowledge` it had no live input at all.
 *
 * The fixture is the ground truth from the handoff (Charles Jack Yaker, his parents, his
 * brother, and the event of his death), plus one Organization so these tests fail if the
 * implementation ever narrows back to a family-only special case.
 *
 * The fake binding mirrors the quirks that matter: a projection can be rejected (the
 * index has to fall back), and `labels(n)` comes back as a JSON array string.
 */

import {
  OntologyIndex,
  extractDates,
  detectKinshipCues,
  tokenize,
  ENTITY_LABELS,
  type OntologyQueryExecutor,
  type NeighbourReader,
  type NeighbourRef
} from '../storage/OntologyIndex.js'

interface FakeNode {
  id: string
  labels: string[]
  props: Record<string, string>
}

interface FakeEdge {
  from: string
  type: string
  to: string
}

interface FakeDbOptions {
  /** Reject any projection naming `labels(n)`, as an older build would. */
  noLabelsFunction?: boolean
  /** Reject the long detail projection, forcing the identity-only fallback. */
  noDetailProjection?: boolean
  /** Every query throws. */
  broken?: boolean
}

class FakeDb implements OntologyQueryExecutor {
  readonly queries: string[] = []

  constructor(private nodes: FakeNode[], private opts: FakeDbOptions = {}) {}

  execute(cypher: string) {
    this.queries.push(cypher)
    if (this.opts.broken) throw new Error('database is closed')

    const m = cypher.match(/^MATCH \(n:(\w+)\) RETURN (.+) LIMIT \d+$/)
    if (!m) throw new Error(`unsupported query: ${cypher}`)
    const [, label, projection] = m

    if (this.opts.noLabelsFunction && projection.includes('labels(n)')) {
      throw new Error('unknown function labels()')
    }
    // The detail list is the only projection long enough to name `causeOfDeath`.
    if (this.opts.noDetailProjection && projection.includes('n.causeOfDeath')) {
      throw new Error('projection too long')
    }

    const columns = projection.split(', ')
    const rows = this.nodes
      .filter(n => n.labels.includes(label))
      .map(n => {
        const row: Record<string, unknown> = {}
        for (const col of columns) {
          if (col === 'labels(n)') { row[col] = JSON.stringify(n.labels); continue }
          const prop = col.slice('n.'.length)
          row[col] = prop === 'id' ? n.id : (n.props[prop] ?? null)
        }
        return row
      })
    return { columns, rows }
  }
}

class FakeEdges implements NeighbourReader {
  constructor(private edges: FakeEdge[]) {}
  relationshipsFor(id: string): NeighbourRef[] {
    const out: NeighbourRef[] = []
    for (const e of this.edges) {
      if (e.from === id) out.push({ relationship: e.type, relatedNode: e.to, direction: 'outgoing' })
      if (e.to === id) out.push({ relationship: e.type, relatedNode: e.from, direction: 'incoming' })
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Ground-truth fixture
// ---------------------------------------------------------------------------

const NODES: FakeNode[] = [
  {
    id: 'charles_yaker',
    labels: ['Person'],
    props: {
      name: 'Charles Yaker',
      fullName: 'Charles Jack Yaker',
      nickname: 'Charlie',
      birthdate: '1940-12-04',
      passed: '2023-07-12',
      causeOfDeath: 'Pancreatic cancer (diagnosed Sept 2022)',
      relationship: 'father',
      profession: 'Nursing home administrator',
      residence: 'Fair Lawn NJ, then RV, then Florida',
      sex: 'male'
    }
  },
  {
    id: 'richard_yaker',
    labels: ['Person'],
    props: { name: 'Richard Yaker', nickname: 'Rich', sex: 'male', role: 'self' }
  },
  {
    id: 'deborah_yaker',
    labels: ['Person'],
    props: { name: 'Deborah Yaker', nickname: 'Debby', relationship: 'mother', sex: 'female' }
  },
  {
    id: 'edward_yaker',
    labels: ['Person'],
    props: { name: 'Edward Yaker', nickname: 'Eddie', aliases: '["Eddie","Eddie Yaker"]', sex: 'male' }
  },
  { id: 'sol_yaker', labels: ['Person'], props: { name: 'Sol Yaker', sex: 'male' } },
  { id: 'mary_yaker', labels: ['Person'], props: { name: 'Mary Yaker', sex: 'female' } },
  {
    id: 'evt_charlie_death',
    labels: ['Event'],
    props: {
      name: "Charlie's passing",
      date: '2023-07-12',
      description: 'Charles Jack Yaker died of pancreatic cancer'
    }
  },
  {
    id: 'org_tengo',
    labels: ['Organization'],
    props: { name: 'Tengo', industry: 'Insurance technology', purpose: 'Cash value banking' }
  },
  // A technical entry that a naive "parent" match would drag in.
  {
    id: 'concept_rebase',
    labels: ['Concept'],
    props: { name: 'Interactive rebase', description: 'Squash commits onto a parent commit' }
  }
]

const EDGES: FakeEdge[] = [
  { from: 'charles_yaker', type: 'PARENT_OF', to: 'richard_yaker' },
  { from: 'deborah_yaker', type: 'PARENT_OF', to: 'richard_yaker' },
  { from: 'sol_yaker', type: 'PARENT_OF', to: 'charles_yaker' },
  { from: 'mary_yaker', type: 'PARENT_OF', to: 'charles_yaker' },
  { from: 'charles_yaker', type: 'SIBLING_OF', to: 'edward_yaker' },
  { from: 'richard_yaker', type: 'EXPERIENCED', to: 'evt_charlie_death' }
]

function buildIndex(opts: FakeDbOptions = {}) {
  const db = new FakeDb(NODES, opts)
  const index = new OntologyIndex(db, {
    edges: new FakeEdges(EDGES),
    selfId: 'richard_yaker'
  })
  return { db, index }
}

const ids = (matches: Array<{ entity: { id: string } }>) => matches.map(m => m.entity.id)

describe('OntologyIndex', () => {
  describe('indexing', () => {
    it('reads every ontology label, not just Knowledge', () => {
      const { index } = buildIndex()
      index.build()
      expect(index.size).toBe(NODES.length)
      expect(index.get('charles_yaker')?.labels).toEqual(['Person'])
      expect(index.get('evt_charlie_death')?.labels).toEqual(['Event'])
    })

    it('scans exactly the shared ENTITY_LABELS set', () => {
      const { db, index } = buildIndex()
      index.build()
      for (const label of ENTITY_LABELS) {
        expect(db.queries.some(q => q.startsWith(`MATCH (n:${label})`))).toBe(true)
      }
    })

    it('prefers fullName as the display name and keeps every variant', () => {
      const { index } = buildIndex()
      const charlie = index.get('charles_yaker')!
      expect(charlie.name).toBe('Charles Jack Yaker')
      expect(charlie.nameVariants).toEqual(
        expect.arrayContaining(['Charles Jack Yaker', 'Charles Yaker', 'Charlie', 'charles_yaker'])
      )
    })

    it('renders a readable card rather than a property dump', () => {
      const { index } = buildIndex()
      const card = index.get('charles_yaker')!.content
      expect(card.split('\n')[0]).toBe('Charles Jack Yaker (Charlie) — Person')
      expect(card).toContain('relationship: father')
      expect(card).toContain('profession: Nursing home administrator')
      expect(card).toContain('passed: 2023-07-12')
    })

    it('decodes a JSON-array aliases property', () => {
      const { index } = buildIndex()
      expect(index.get('edward_yaker')!.nameVariants).toEqual(expect.arrayContaining(['Eddie', 'Eddie Yaker']))
    })

    it('falls back through projections when the binding rejects one', () => {
      // Older bindings have no labels() and choke on a long projection. Losing the
      // detail columns must cost detail, never the entity itself.
      const { index } = buildIndex({ noLabelsFunction: true, noDetailProjection: true })
      index.build()
      expect(index.size).toBe(NODES.length)
      expect(index.get('charles_yaker')!.name).toBe('Charles Jack Yaker')
      expect(index.get('charles_yaker')!.props.causeOfDeath).toBeUndefined()
    })

    it('survives an unreadable graph instead of throwing into the search path', () => {
      const index = new OntologyIndex(new FakeDb(NODES, { broken: true }))
      expect(() => index.build()).not.toThrow()
      expect(index.search('my dad')).toEqual([])
    })

    it('does not rescan on every search', () => {
      const { db, index } = buildIndex()
      index.search('my dad')
      const afterFirst = db.queries.length
      index.search('Charles Jack Yaker')
      expect(db.queries.length).toBe(afterFirst)
    })
  })

  describe('kinship queries', () => {
    it('resolves "my dad" to Charles, not to the other parent', () => {
      const { index } = buildIndex()
      const matches = index.search('Tell me about my dad')
      expect(matches[0].entity.id).toBe('charles_yaker')
      expect(matches[0].entity.labels).toEqual(['Person'])
      expect(matches[0].score).toBeGreaterThanOrEqual(0.9)
      expect(matches[0].reasons.join(',')).toContain('kinship:father')
      // Deborah is PARENT_OF Richard too; only the stated relationship separates them.
      expect(ids(matches)).not.toContain('deborah_yaker')
    })

    it('resolves "my father" and "my mom" through the same path', () => {
      const { index } = buildIndex()
      expect(index.search('what do I know about my father')[0].entity.id).toBe('charles_yaker')
      expect(index.search('my mom')[0].entity.id).toBe('deborah_yaker')
    })

    it('scores both relatives when two cues fire in the same query', () => {
      const { index } = buildIndex()
      const matches = ids(index.search('tell me about my mom and dad'))
      expect(matches).toContain('charles_yaker')
      expect(matches).toContain('deborah_yaker')
    })

    it('walks two hops for grandparents', () => {
      const { index } = buildIndex()
      // Sol states no relationship at all — only PARENT_OF → PARENT_OF plus sex reaches him.
      expect(ids(index.search('my grandfather'))).toContain('sol_yaker')
      expect(ids(index.search('my grandfather'))).not.toContain('mary_yaker')
      expect(ids(index.search('my grandmother'))).toContain('mary_yaker')
    })

    it('walks parent-then-sibling for an uncle', () => {
      const { index } = buildIndex()
      expect(ids(index.search('my uncle'))).toContain('edward_yaker')
    })

    it('lets a broad cue subsume the specific relationships it covers', () => {
      const { index } = buildIndex()
      // "father" must not read as a contradiction of "parents".
      const matches = ids(index.search('my parents'))
      expect(matches).toContain('charles_yaker')
      expect(matches).toContain('deborah_yaker')
    })

    it('degrades to stated relationships when there is no adjacency', () => {
      const index = new OntologyIndex(new FakeDb(NODES), { selfId: 'richard_yaker' })
      expect(index.search('my dad')[0].entity.id).toBe('charles_yaker')
    })

    it('returns nothing for a kinship cue with no self node and no stated relationship', () => {
      const index = new OntologyIndex(new FakeDb(NODES), { edges: new FakeEdges(EDGES), selfId: null })
      expect(ids(index.search('my grandfather', { selfId: null }))).not.toContain('sol_yaker')
    })
  })

  describe('name queries', () => {
    it('returns the Person node for a full name', () => {
      const { index } = buildIndex()
      const matches = index.search('Charles Jack Yaker')
      expect(matches[0].entity.id).toBe('charles_yaker')
      expect(matches[0].reasons).toContain('name')
    })

    it('ranks the nickname holder above the others who share the surname', () => {
      const { index } = buildIndex()
      const matches = index.search('who is Eddie Yaker')
      expect(matches[0].entity.id).toBe('edward_yaker')
    })

    it('resolves a nickname on its own', () => {
      const { index } = buildIndex()
      expect(index.search('Debby')[0].entity.id).toBe('deborah_yaker')
    })

    it('does not let a shared surname alone match everybody', () => {
      // "Yaker" is carried by six nodes; on its own it is not an identification.
      const { index } = buildIndex()
      expect(index.search('Yaker')).toEqual([])
    })
  })

  describe('non-Person ontology labels', () => {
    it('surfaces an Event from a date written in prose', () => {
      const { index } = buildIndex()
      const matches = index.search('what happened July 12 2023')
      expect(ids(matches)).toContain('evt_charlie_death')
      expect(matches.find(m => m.entity.id === 'evt_charlie_death')!.reasons)
        .toContain('date:2023-07-12')
    })

    it('accepts the other ways that date gets written', () => {
      const { index } = buildIndex()
      for (const q of ['2023-07-12', '7/12/2023', '12 July 2023']) {
        expect(ids(index.search(q))).toContain('evt_charlie_death')
      }
    })

    it('surfaces an Organization by name', () => {
      const { index } = buildIndex()
      const matches = index.search('Tengo')
      expect(matches[0].entity.id).toBe('org_tengo')
      expect(matches[0].entity.labels).toEqual(['Organization'])
    })

    it('surfaces a person from a distinctive property value', () => {
      const { index } = buildIndex()
      expect(ids(index.search('Fair Lawn'))).toContain('charles_yaker')
    })
  })

  describe('guards against firing on technical queries', () => {
    it('does not read a git parent commit as somebody\'s father', () => {
      const { index } = buildIndex()
      // "parent" is a weak cue: no first-person possessive, no kinship expansion.
      const matches = ids(index.search('squash the commits onto the parent commit before rebase'))
      expect(matches).not.toContain('charles_yaker')
      expect(matches).not.toContain('deborah_yaker')
    })

    it('keeps a technical query on technical entities', () => {
      const { index } = buildIndex()
      const matches = ids(index.search('rebase the stacked PR onto its parent branch'))
      // Returning the `Interactive rebase` Concept is the arm working; returning a
      // relative because the query said "parent" is the failure being guarded against.
      expect(matches.every(id => !id.endsWith('_yaker'))).toBe(true)
    })

    it('does not match on a word that half the graph carries', () => {
      // "yaker" is in seven of nine cards. Common enough to be no evidence at all —
      // neither as a name (it identifies none of the six Yakers) nor as free text.
      const { index } = buildIndex()
      expect(index.search('yaker')).toEqual([])
    })

    it('does allow a single RARE property term — that is the distinction', () => {
      const { index } = buildIndex()
      const matches = ids(index.search('cancer'))
      expect(matches).toContain('charles_yaker')
      expect(matches).toContain('evt_charlie_death')
    })
  })

  describe('helpers', () => {
    it('tokenizes an id the way it tokenizes a name', () => {
      expect(tokenize('charles_yaker')).toEqual(['charles', 'yaker'])
    })

    it('only fires weak cues under a first-person possessive', () => {
      expect(detectKinshipCues('the parent commit').map(s => s.cue)).toEqual([])
      expect(detectKinshipCues('my parents').map(s => s.cue)).toEqual(['parent'])
      // Strong cues need no such licence.
      expect(detectKinshipCues('Charlie was a father').map(s => s.cue)).toEqual(['father'])
    })

    it('extracts dates without inventing them', () => {
      expect(extractDates('July 12 2023')).toEqual(['2023-07-12'])
      expect(extractDates('nothing dated here')).toEqual([])
      expect(extractDates('version 1.2.3 of the 4 tools')).toEqual([])
    })
  })
})
