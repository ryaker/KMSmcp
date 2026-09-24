/**
 * Tests for the agreement statistics harness (`../eval/agreement.ts`) — confusion matrix,
 * exact/binary agreement, and both Cohen's kappas, pinned against known small examples
 * (hand-computed, not derived from the implementation).
 */
import {
  binaryAgreement,
  buildAgreementReport,
  cohenKappaUnweighted,
  cohenKappaWeighted,
  confusionMatrix,
  exactAgreement,
  sliceAgreementPairs,
  summarizeAgreement,
  type AgreementPair,
} from '../eval/agreement.js'

const pair = (gemmaGrade: 0 | 1 | 2, jevGrade: 0 | 1 | 2, source: AgreementPair['source'] = 'eng', kind: AgreementPair['kind'] = 'human'): AgreementPair => ({
  gemmaGrade,
  jevGrade,
  source,
  kind,
})

// ── confusion matrix ─────────────────────────────────────────────────────────

describe('confusionMatrix', () => {
  it('counts each (gemma, jev) combination', () => {
    const pairs = [pair(0, 0), pair(0, 1), pair(2, 2), pair(2, 2), pair(1, 0)]
    const m = confusionMatrix(pairs)
    expect(m).toEqual([
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, 2],
    ])
  })

  it('is all zeros for no pairs', () => {
    expect(confusionMatrix([])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ])
  })
})

// ── exact agreement ──────────────────────────────────────────────────────────

describe('exactAgreement', () => {
  it('is the diagonal share', () => {
    const pairs = [pair(0, 0), pair(1, 1), pair(2, 0), pair(2, 2)]
    expect(exactAgreement(pairs)).toBe(0.75)
  })

  it('is 0 for no pairs (never NaN)', () => {
    expect(exactAgreement([])).toBe(0)
  })

  it('is 1 when every pair agrees', () => {
    expect(exactAgreement([pair(0, 0), pair(1, 1), pair(2, 2)])).toBe(1)
  })

  it('is 0 when no pair agrees', () => {
    expect(exactAgreement([pair(0, 1), pair(1, 2), pair(2, 0)])).toBe(0)
  })
})

// ── binary agreement ──────────────────────────────────────────────────────────

describe('binaryAgreement', () => {
  it('strict: only grade 2 counts as relevant on each side', () => {
    // (2,2) agree-relevant; (0,1) agree-not-relevant (strict); (2,1) disagree; (1,0) agree-not-relevant
    const pairs = [pair(2, 2), pair(0, 1), pair(2, 1), pair(1, 0)]
    expect(binaryAgreement(pairs, 'strict')).toBe(0.75)
  })

  it('lenient: grade >=1 counts as relevant on each side', () => {
    // (2,2) agree; (0,1) disagree (0 not-relevant, 1 relevant); (2,1) agree (both relevant); (1,0) disagree
    const pairs = [pair(2, 2), pair(0, 1), pair(2, 1), pair(1, 0)]
    expect(binaryAgreement(pairs, 'lenient')).toBe(0.5)
  })

  it('is 0 for no pairs', () => {
    expect(binaryAgreement([], 'strict')).toBe(0)
  })
})

// ── Cohen's kappa — hand-computed fixtures ────────────────────────────────────
//
// Classic textbook fixture (e.g. Fleiss): 2 raters x 3 categories,
//   confusion (rows=gemma, cols=jev):
//     [10, 2, 0]
//     [1,  9, 2]
//     [0,  1, 5]
//   n = 30, po = (10+9+5)/30 = 0.8
//   row marginals: [12, 12, 6] / 30 ; col marginals: [11, 12, 7] / 30
//   pe = (12/30)(11/30) + (12/30)(12/30) + (6/30)(7/30)
//      = (132 + 144 + 42) / 900 = 318/900 = 0.353333...
//   kappa = (0.8 - 0.353333) / (1 - 0.353333) = 0.446667 / 0.646667 = 0.690...

function buildFixturePairs(): AgreementPair[] {
  const counts: [number, number, number][] = [
    [10, 2, 0],
    [1, 9, 2],
    [0, 1, 5],
  ]
  const pairs: AgreementPair[] = []
  for (let g = 0; g < 3; g++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < counts[g][j]; k++) pairs.push(pair(g as 0 | 1 | 2, j as 0 | 1 | 2))
    }
  }
  return pairs
}

describe('cohenKappaUnweighted', () => {
  it('matches the hand-computed value for the fixture confusion matrix', () => {
    const pairs = buildFixturePairs()
    expect(pairs.length).toBe(30)
    expect(cohenKappaUnweighted(pairs)).toBeCloseTo(0.6907, 3)
  })

  it('is 1 for perfect agreement', () => {
    const pairs = [pair(0, 0), pair(0, 0), pair(1, 1), pair(2, 2), pair(2, 2)]
    expect(cohenKappaUnweighted(pairs)).toBeCloseTo(1, 10)
  })

  it('is 0 for no pairs (never NaN)', () => {
    expect(cohenKappaUnweighted([])).toBe(0)
  })

  it('is close to 0 for agreement no better than the marginals predict (both labellers pick uniformly at random, independently)', () => {
    // Every (gemma, jev) combination appears equally often -> po == pe exactly -> kappa == 0.
    const pairs: AgreementPair[] = []
    for (let g = 0; g < 3; g++) for (let j = 0; j < 3; j++) for (let k = 0; k < 5; k++) pairs.push(pair(g as 0 | 1 | 2, j as 0 | 1 | 2))
    expect(cohenKappaUnweighted(pairs)).toBeCloseTo(0, 10)
  })
})

describe('cohenKappaWeighted', () => {
  // Linear weights: w(0,0)=w(1,1)=w(2,2)=1; w adjacent (dist 1) = 0.5; w opposite (dist 2) = 0.
  // po_w = sum(w_ij * n_ij)/n. Using the same fixture:
  //   diag (w=1): 10+9+5=24 -> 24
  //   dist1 (w=0.5): (0,1)=2, (1,0)=1, (1,2)=2, (2,1)=1 -> sum=6 -> 6*0.5=3
  //   dist2 (w=0): (0,2)=0, (2,0)=0 -> 0
  //   po_w = (24+3+0)/30 = 27/30 = 0.9
  //   pe_w = sum_ij w_ij * row_i/n * col_j/n
  //     diag terms (w=1): (12*11 + 12*12 + 6*7)/900 = (132+144+42)/900 = 318/900
  //     dist1 terms (w=0.5): pairs (0,1),(1,0),(1,2),(2,1)
  //       (0,1): 12*12=144 ; (1,0): 12*11=132 ; (1,2): 12*7=84 ; (2,1): 6*12=72
  //       sum=432 ; *0.5/900 = 216/900
  //     dist2 terms (w=0): 0
  //     pe_w = (318+216)/900 = 534/900 = 0.593333...
  //   kappa_w = (0.9 - 0.593333)/(1 - 0.593333) = 0.306667/0.406667 = 0.7541
  it('matches the hand-computed value for the fixture confusion matrix', () => {
    const pairs = buildFixturePairs()
    expect(cohenKappaWeighted(pairs)).toBeCloseTo(0.7541, 3)
  })

  it('is 1 for perfect agreement', () => {
    expect(cohenKappaWeighted([pair(0, 0), pair(1, 1), pair(2, 2)])).toBeCloseTo(1, 10)
  })

  it('is 0 for no pairs (never NaN)', () => {
    expect(cohenKappaWeighted([])).toBe(0)
  })

  it('penalises an opposite-ends disagreement (0 vs 2) more than an adjacent one (1 vs 2) for the same exact-agreement rate', () => {
    const adjacentOnly: AgreementPair[] = [pair(0, 0), pair(1, 1), pair(2, 1)] // one dist-1 miss
    const oppositeOnly: AgreementPair[] = [pair(0, 0), pair(1, 1), pair(2, 0)] // one dist-2 miss
    expect(exactAgreement(adjacentOnly)).toBe(exactAgreement(oppositeOnly))
    expect(cohenKappaWeighted(adjacentOnly)).toBeGreaterThan(cohenKappaWeighted(oppositeOnly))
  })
})

// ── slicing + summary ─────────────────────────────────────────────────────────

describe('sliceAgreementPairs', () => {
  it('slices by overall, source (including the prototype pseudo-source), and kind', () => {
    const pairs = [
      pair(0, 0, 'eng', 'human'),
      pair(1, 1, 'personal', 'agent-payload'),
      pair(2, 2, 'prototype', 'human'),
    ]
    const slices = sliceAgreementPairs(pairs)
    expect(slices.overall).toHaveLength(3)
    expect(slices['source:eng']).toHaveLength(1)
    expect(slices['source:personal']).toHaveLength(1)
    expect(slices['source:prototype']).toHaveLength(1)
    expect(slices['kind:human']).toHaveLength(2)
    expect(slices['kind:agent-payload']).toHaveLength(1)
  })

  it('an empty slice is [], not undefined', () => {
    const slices = sliceAgreementPairs([pair(0, 0, 'eng', 'human')])
    expect(slices['source:personal']).toEqual([])
  })
})

describe('summarizeAgreement / buildAgreementReport', () => {
  it('reports n=0 and zeroed stats for an empty slice, without throwing', () => {
    const s = summarizeAgreement('source:personal', [])
    expect(s.n).toBe(0)
    expect(s.exactAgreement).toBe(0)
    expect(s.kappaUnweighted).toBe(0)
    expect(s.kappaWeighted).toBe(0)
  })

  it('buildAgreementReport produces one summary per slice (overall + 3 sources + 2 kinds)', () => {
    const pairs = [pair(0, 0, 'eng', 'human'), pair(2, 2, 'personal', 'agent-payload')]
    const report = buildAgreementReport(pairs)
    expect(report.map(r => r.slice).sort()).toEqual(
      ['kind:agent-payload', 'kind:human', 'overall', 'source:eng', 'source:personal', 'source:prototype'].sort()
    )
  })
})
