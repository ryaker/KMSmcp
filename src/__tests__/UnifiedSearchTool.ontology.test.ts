/**
 * End-to-end cover for the ontology miss in `unified_search`.
 *
 * The failure this pins, as reported against the live store on 2026-09-13: asking
 * "Tell me about my dad" returned technical noise. The Person node `charles_yaker`
 * (Charles Jack Yaker, `relationship: father`, `PARENT_OF` → Richard) is in the graph,
 * and so are the family edges — but `SparrowDBStorage.search` only scored the Knowledge
 * content sidecar and stamped every hit `nodeLabels: ['Knowledge']`, so:
 *
 *   1. the Person node was unreachable from the read path, and
 *   2. `expandWithEntityContext` — which gates on entity labels — had no live input,
 *      leaving `entity_context` permanently empty for ontology entities.
 *
 * Two things are pinned here that the OntologyIndex unit tests cannot reach, because
 * they are properties of the merged pipeline rather than of the index:
 *
 *   - an entity card shares almost no tokens with the query that retrieved it, so
 *     without a relevance floor the fix would surface Charlie into the candidate pool
 *     and then rank him below the noise anyway;
 *   - a technical query about a "parent commit" must not be wrecked by any of this.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

/** The Person card the ontology arm produces, in the shape SparrowDBStorage emits. */
const charlieCard = () => ({
  id: 'charles_yaker',
  content: [
    'Charles Jack Yaker (Charlie) — Person',
    'relationship: father',
    'profession: Nursing home administrator',
    'birthdate: 1940-12-04',
    'passed: 2023-07-12'
  ].join('\n'),
  confidence: 1,
  contentType: 'entity',
  source: 'personal',
  sourceSystem: 'sparrowdb',
  timestamp: undefined,
  nodeLabels: ['Person'],
  _ontologyScore: 1,
  metadata: { ontology: true, matchReasons: ['kinship:father:stated'] },
  relationships: [
    { relationship: 'PARENT_OF', relatedNode: 'richard_yaker', relatedContent: 'Richard Yaker', direction: 'outgoing', strength: null },
    { relationship: 'SIBLING_OF', relatedNode: 'edward_yaker', relatedContent: 'Edward Yaker', direction: 'outgoing', strength: null }
  ]
})

/**
 * The noise that buried the real answer. Recent, keyword-dense, and every one of them
 * contains a literal "father"/"parent" — which is exactly why lexical ranking alone put
 * them above a Person node that contains neither "my" nor "dad".
 */
const NOISE = [
  {
    id: 'k1',
    content: 'Git: squash the parent commit before rebasing the stacked PR onto main; the parent of a merge commit is its first parent.',
    confidence: 1, contentType: 'procedure', source: 'technical', timestamp: daysAgo(2), nodeLabels: ['Knowledge'], relationships: []
  },
  {
    id: 'k2',
    content: 'Kyle Frager is the father of my nieces and nephews on the Fox family side.',
    confidence: 1, contentType: 'fact', source: 'personal', timestamp: daysAgo(3), nodeLabels: ['Knowledge'], relationships: []
  },
  {
    id: 'k3',
    content: 'Chestin family office: the parent entity holds the operating companies; the father-son succession plan is unresolved.',
    confidence: 1, contentType: 'insight', source: 'technical', timestamp: daysAgo(1), nodeLabels: ['Knowledge'], relationships: []
  }
]

function makeTool(graphResults: any[], mem0Results: any[] = []) {
  const graph = {
    search: jest.fn().mockResolvedValue(graphResults),
    getOperationalNodes: jest.fn().mockResolvedValue([]),
    getEntitySummary: jest.fn().mockImplementation(async (id: string) =>
      id === 'charles_yaker'
        ? {
            id,
            name: 'Charles Jack Yaker',
            type: ['Person'],
            summary: 'Charles Jack Yaker (Charlie) — Person',
            key_props: { relationship: 'father', profession: 'Nursing home administrator' },
            top_relationships: [{ rel: 'PARENT_OF', direction: 'outgoing', id: 'richard_yaker', name: 'Richard Yaker' }]
          }
        : null
    )
  }
  const mem0 = { search: jest.fn().mockResolvedValue(mem0Results) }
  const mongodb = { search: jest.fn().mockResolvedValue([]) }
  return new UnifiedSearchTool({ graph, mem0, mongodb } as any, null as any)
}

describe('unified_search — ontology entities', () => {
  it('ranks the Person node above keyword noise for "my dad"', async () => {
    const tool = makeTool([charlieCard(), ...NOISE])
    const out = await tool.search({ query: 'Tell me about my dad' })

    expect(out.results[0].id).toBe('charles_yaker')
    expect(out.results[0].nodeLabels).toEqual(['Person'])
    // The reason it can win: its own match score stands in for a lexical relevance that
    // is legitimately ~0 — "Charles Jack Yaker" contains neither "my" nor "dad".
    expect(out.results[0]._relevance).toBe(1)
  })

  it('returns the parent relationship alongside the entity', async () => {
    const tool = makeTool([charlieCard(), ...NOISE])
    const out = await tool.search({ query: 'Tell me about my dad' })
    const rels = out.results[0].relationships.map((r: any) => r.relationship)
    expect(rels).toContain('PARENT_OF')
  })

  it('fills entity_context, which was permanently empty before', async () => {
    const tool = makeTool([charlieCard(), ...NOISE])
    const out = await tool.search({ query: 'Tell me about my dad' })

    expect(Object.keys(out.entity_context!)).toContain('charles_yaker')
    expect(out.entity_context!['charles_yaker'].name).toBe('Charles Jack Yaker')
    expect(out.results[0].linkedEntityIds).toContain('charles_yaker')
  })

  it('does not wreck a technical query that says "parent"', async () => {
    // The ontology arm stands down on this query, so the graph arm returns Knowledge
    // only — and the engineering entry must still rank first.
    const tool = makeTool(NOISE)
    const out = await tool.search({ query: 'squash the parent commit when rebasing a stacked PR' })

    expect(out.results[0].id).toBe('k1')
    expect(out.results.map(r => r.id)).not.toContain('charles_yaker')
  })

  it('does not let an entity outrank a strong lexical match on its own subject', async () => {
    // A floor, never a bonus: an entity scoring 1 ties a perfect lexical match rather
    // than displacing it, and recency then decides — which is the pre-existing rule.
    const exact = {
      id: 'k9',
      content: 'Charles Jack Yaker',
      confidence: 1, contentType: 'fact', source: 'personal',
      timestamp: new Date().toISOString(), nodeLabels: ['Knowledge'], relationships: []
    }
    const tool = makeTool([{ ...charlieCard(), _ontologyScore: 0.76 }, exact])
    const out = await tool.search({ query: 'Charles Jack Yaker' })
    expect(out.results[0].id).toBe('k9')
  })

  it('leaves results without an ontology score scored exactly as before', async () => {
    const tool = makeTool(NOISE)
    const out = await tool.search({ query: 'stacked PR parent commit' })
    for (const r of out.results) {
      expect(r._ontologyScore).toBeUndefined()
      expect(r._relevance).toBe((tool as any).calculateRelevance(r.content, 'stacked PR parent commit'))
    }
  })

  it('ignores a malformed ontology score rather than trusting it', async () => {
    const bogus = { ...charlieCard(), _ontologyScore: 99 }
    const tool = makeTool([bogus, ...NOISE])
    const out = await tool.search({ query: 'Tell me about my dad' })
    // Clamped into [0, 1]; it cannot buy an unbounded rank.
    expect(out.results[0]._relevance).toBeLessThanOrEqual(1)
  })
})
