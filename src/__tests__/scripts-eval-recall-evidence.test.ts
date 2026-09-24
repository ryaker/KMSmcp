/**
 * Pure helpers from the offline eval script — paired win/loss counting, the bootstrap CI,
 * and the instruction/contradiction rule counts. No network, no Jev, no file I/O: these
 * take plain arrays / in-memory results.
 */
import { bootstrapDeltaCI, flagCounts, pairedWinsLosses } from '../scripts/eval-recall-evidence.js'

describe('pairedWinsLosses', () => {
  it('counts a v2 win when v2 scores 1 and v1 scores 0 at the same query index', () => {
    expect(pairedWinsLosses([1, 0, 1], [0, 0, 1])).toEqual({ wins: 1, losses: 0, ties: 2 })
  })

  it('counts a v2 loss the other way round', () => {
    expect(pairedWinsLosses([0, 1], [1, 1])).toEqual({ wins: 0, losses: 1, ties: 1 })
  })

  it('is all ties when the two orderings agree on every top-1', () => {
    expect(pairedWinsLosses([1, 0, 1], [1, 0, 1])).toEqual({ wins: 0, losses: 0, ties: 3 })
  })
})

describe('bootstrapDeltaCI', () => {
  it('reports mean(a - b) as the point estimate', () => {
    const ci = bootstrapDeltaCI([1, 1, 1, 0], [0, 0, 0, 0], 500)
    expect(ci.mean).toBeCloseTo(0.75, 6)
  })

  it('is deterministic for a fixed seed — same inputs, same CI, every run', () => {
    const a = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1]
    const b = [0, 0, 1, 0, 0, 1, 0, 1, 1, 0]
    const ci1 = bootstrapDeltaCI(a, b, 2000, 42)
    const ci2 = bootstrapDeltaCI(a, b, 2000, 42)
    expect(ci1).toEqual(ci2)
  })

  it('collapses to a point (lo == hi == mean) when every paired difference is identical', () => {
    const ci = bootstrapDeltaCI([1, 1, 1], [0, 0, 0], 300)
    expect(ci.lo).toBeCloseTo(1, 6)
    expect(ci.hi).toBeCloseTo(1, 6)
    expect(ci.mean).toBeCloseTo(1, 6)
  })

  it('brackets the mean: lo <= mean <= hi when differences vary', () => {
    const ci = bootstrapDeltaCI([1, 0, 1, 0, 1, 0, 1, 1], [0, 0, 1, 1, 0, 0, 0, 1], 2000)
    expect(ci.lo).toBeLessThanOrEqual(ci.mean + 1e-9)
    expect(ci.hi).toBeGreaterThanOrEqual(ci.mean - 1e-9)
  })
})

describe('flagCounts', () => {
  const result = (id: string, containsInstruction: number | null, contradictsPremise: number | null) => ({
    pair: { queryIndex: 0, query: 'q', candidate: { id, prod_rank: 1, content: '', jevA: 0, jevB: 0, grade: 0 } },
    answer:
      containsInstruction === null && contradictsPremise === null
        ? null
        : {
            answers_query: 0.5,
            evidence_value: 2,
            contradicts_premise: contradictsPremise ?? 0,
            contains_instruction: containsInstruction ?? 0,
            describes_past_state: 0,
            model: 'jev-1.13.0',
            input_tokens: 100,
            output_tokens: 0,
            cost_usd_estimate: 0.000004,
          },
    error: containsInstruction === null && contradictsPremise === null ? 'engine fault' : null,
    fromCache: false,
  })

  it('counts strictly above 0.7 on each dimension independently, with up to three sample ids', () => {
    const results = [
      result('a', 0.95, 0.1),
      result('b', 0.5, 0.99),
      result('c', 0.71, 0.71),
      result('d', 0.7, 0.7), // exactly at threshold — not counted
      result('e', null, null), // failed call — excluded from judged, not counted either
    ]
    const flags = flagCounts(results)
    expect(flags.judged).toBe(4)
    expect(flags.instructionCount).toBe(2)
    expect(flags.contradictionCount).toBe(2)
    expect(flags.instructionSample).toEqual(['a', 'c'])
    expect(flags.contradictionSample).toEqual(['b', 'c'])
  })

  it('caps the sample at 3 ids even with more matches', () => {
    const results = ['a', 'b', 'c', 'd', 'e'].map(id => result(id, 0.9, 0))
    const flags = flagCounts(results)
    expect(flags.instructionCount).toBe(5)
    expect(flags.instructionSample).toHaveLength(3)
  })
})
