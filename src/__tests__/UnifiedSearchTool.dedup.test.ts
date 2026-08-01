/**
 * Cross-backend deduplication tests for UnifiedSearchTool.
 *
 * `unified_store` dual-writes one entry to graph + mem0 + mongodb under a single id,
 * so the same fact arrives at dedup 2-3 times. The copies differ in ways that matter:
 * only the graph copy carries `relationships`, and `confidence` means different things
 * per backend (graph = lexical match score < 1; mongodb = stored author confidence = 1).
 *
 * The old implementation kept "the highest confidence copy", which compared those two
 * different quantities and so reliably discarded the graph copy — the only one with
 * relationships. Symptom: `sources: {graph: 8}` alongside `relationships: []` on every
 * result. These tests pin the merge behaviour that replaced it.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'

const tool = new UnifiedSearchTool({} as any, {} as any)
const dedupe = (results: any[]) => (tool as any).deduplicateResults(results)

const graphCopy = (over: any = {}) => ({
  id: 'shared-id-1',
  content: 'Ollama classify timeout raised to 8000ms',
  confidence: 0.6,                     // lexical match score
  sourceSystem: 'graph',
  relationships: [{ type: 'SOLVES', targetId: 'other-id', strength: 0.9 }],
  ...over,
})

const mongoCopy = (over: any = {}) => ({
  id: 'shared-id-1',
  content: 'Ollama classify timeout raised to 8000ms',
  confidence: 1,                       // stored author confidence
  sourceSystem: 'mongodb',
  // note: no `relationships` field at all
  ...over,
})

describe('UnifiedSearchTool.deduplicateResults', () => {
  it('keeps relationships when the mongo copy outranks the graph copy on confidence', () => {
    // The regression case. Mongo's stored confidence (1) beats the graph's lexical
    // score (0.6), so the old code kept mongo and silently dropped every relationship.
    const [out] = dedupe([graphCopy(), mongoCopy()])
    expect(out.relationships).toHaveLength(1)
    expect(out.relationships[0].type).toBe('SOLVES')
  })

  it('keeps relationships regardless of arrival order', () => {
    const [a] = dedupe([mongoCopy(), graphCopy()])
    const [b] = dedupe([graphCopy(), mongoCopy()])
    expect(a.relationships).toHaveLength(1)
    expect(b.relationships).toHaveLength(1)
  })

  it('collapses three backend copies of one entry into a single result', () => {
    const mem0Copy = { id: 'shared-id-1', content: 'Ollama classify timeout raised to 8000ms', confidence: 0.8, sourceSystem: 'mem0' }
    const out = dedupe([graphCopy(), mongoCopy(), mem0Copy])
    expect(out).toHaveLength(1)
    expect(out[0].relationships).toHaveLength(1)
  })

  it('records every backend the entry came from', () => {
    const [out] = dedupe([graphCopy(), mongoCopy()])
    expect(out._sourceSystems.sort()).toEqual(['graph', 'mongodb'])
  })

  it('keeps the stored confidence, not the lexical match score', () => {
    const [out] = dedupe([graphCopy(), mongoCopy()])
    expect(out.confidence).toBe(1)
  })

  it('prefers the longer content when a backend stores a truncated projection', () => {
    const full = mongoCopy({ content: 'Ollama classify timeout raised to 8000ms after measuring 5219ms cold load' })
    const [out] = dedupe([graphCopy(), full])
    expect(out.content).toContain('5219ms cold load')
    // …and still keeps the relationships from the shorter graph copy
    expect(out.relationships).toHaveLength(1)
  })

  it('keeps metadata.entityRefs when the copy that has them loses on content length', () => {
    // Same failure mode as the relationships bug: entityRefs drive linkedEntityIds and
    // expandWithEntityContext, so losing them on merge silently breaks entity linking.
    const short = graphCopy({ metadata: { entityRefs: ['richard_yaker'] } })
    const long = mongoCopy({
      content: 'Ollama classify timeout raised to 8000ms after measuring 5219ms cold load',
      metadata: {}
    })
    const [out] = dedupe([short, long])
    expect(out.metadata.entityRefs).toEqual(['richard_yaker'])
  })

  it('unions entityRefs present on both copies without duplicates', () => {
    const a = graphCopy({ metadata: { entityRefs: ['richard_yaker', 'susan_yaker'] } })
    const b = mongoCopy({ metadata: { entityRefs: ['susan_yaker', 'tyler_sue_child'] } })
    const [out] = dedupe([a, b])
    expect(out.metadata.entityRefs.sort()).toEqual(['richard_yaker', 'susan_yaker', 'tyler_sue_child'])
  })

  it('does not merge genuinely distinct entries', () => {
    const other = graphCopy({ id: 'different-id', content: 'unrelated fact' })
    expect(dedupe([graphCopy(), other])).toHaveLength(2)
  })

  it('falls back to a content hash when an entry has no id', () => {
    const a = { content: 'same text', confidence: 0.5, sourceSystem: 'graph' }
    const b = { content: 'same text', confidence: 0.9, sourceSystem: 'mongodb' }
    expect(dedupe([a, b])).toHaveLength(1)
  })

  it('handles an empty input', () => {
    expect(dedupe([])).toEqual([])
  })

  it('does not invent a relationships field when no backend has one', () => {
    const [out] = dedupe([mongoCopy(), mongoCopy({ sourceSystem: 'mem0', confidence: 0.7 })])
    expect(out.relationships).toBeUndefined()
  })
})
