/**
 * Pure metric tests for the prompt-injection eval — AUC, recall@FPR, FPR, and the
 * per-category recall breakdown. No I/O, no Jev.
 */
import { fprAt, recallAt, recallByCategory, rocAuc, thresholdForFpr } from '../eval/injectionMetrics.js'

describe('rocAuc', () => {
  it('is 1 for perfect separation (every positive scores above every negative)', () => {
    const samples = [
      { score: 0.9, label: 1 as const },
      { score: 0.8, label: 1 as const },
      { score: 0.3, label: 0 as const },
      { score: 0.1, label: 0 as const },
    ]
    expect(rocAuc(samples)).toBe(1)
  })

  it('is 0 when every positive scores below every negative', () => {
    const samples = [
      { score: 0.1, label: 1 as const },
      { score: 0.2, label: 1 as const },
      { score: 0.8, label: 0 as const },
      { score: 0.9, label: 0 as const },
    ]
    expect(rocAuc(samples)).toBe(0)
  })

  it('counts a tie between a positive and a negative as half a win', () => {
    // One pos/neg pair at 0.5 (tie -> 0.5), the other pos clearly above its neg (win -> 1).
    // AUC = mean over both pos x neg pairs since it's a 2x2 comparison: (pos,neg) x (pos,neg).
    const samples = [
      { score: 0.5, label: 1 as const },
      { score: 0.5, label: 0 as const },
    ]
    expect(rocAuc(samples)).toBeCloseTo(0.5, 6)
  })

  it('is 0.5 when every score is identical (no separation at all)', () => {
    const samples = [
      { score: 0.5, label: 1 as const },
      { score: 0.5, label: 1 as const },
      { score: 0.5, label: 0 as const },
      { score: 0.5, label: 0 as const },
    ]
    expect(rocAuc(samples)).toBeCloseTo(0.5, 6)
  })

  it('returns NaN when one class is missing entirely', () => {
    expect(Number.isNaN(rocAuc([{ score: 0.9, label: 1 }]))).toBe(true)
    expect(Number.isNaN(rocAuc([{ score: 0.9, label: 0 }]))).toBe(true)
    expect(Number.isNaN(rocAuc([]))).toBe(true)
  })
})

describe('fprAt / recallAt', () => {
  it('fprAt counts negatives at or above the threshold, inclusive', () => {
    expect(fprAt(0.7, [0.9, 0.7, 0.5, 0.1])).toBeCloseTo(0.5, 6) // 0.9 and 0.7 qualify
  })

  it('recallAt counts positives at or above the threshold, inclusive', () => {
    expect(recallAt(0.7, [0.9, 0.7, 0.5, 0.1])).toBeCloseTo(0.5, 6)
  })

  it('both return 0 (not NaN) on an empty array', () => {
    expect(fprAt(0.5, [])).toBe(0)
    expect(recallAt(0.5, [])).toBe(0)
  })
})

describe('thresholdForFpr', () => {
  it('picks the threshold achieving exactly the target FPR when evenly divisible', () => {
    // 100 negatives, uniformly spaced 0.01..1.00 descending after sort. 1% FPR -> top 1 negative
    // allowed to exceed threshold, so threshold should sit at (or just above) the 2nd-highest score.
    const negatives = Array.from({ length: 100 }, (_, i) => (100 - i) / 100) // 1.00, 0.99, ..., 0.01
    const t = thresholdForFpr(negatives, 0.01)
    expect(fprAt(t, negatives)).toBeLessThanOrEqual(0.01)
    // Confirm it's the *largest* achievable recall — the next lower unique value would exceed budget.
    const negBelow = Math.max(...negatives.filter(n => n < t))
    expect(fprAt(negBelow, negatives)).toBeGreaterThan(0.01)
  })

  it('falls back to a threshold above every negative when even one flagged negative exceeds the budget', () => {
    const negatives = [0.9, 0.5, 0.2] // n=3; flagging just the top one is already FPR 1/3 > 1%
    const t = thresholdForFpr(negatives, 0.01)
    expect(fprAt(t, negatives)).toBe(0)
    expect(t).toBeGreaterThan(Math.max(...negatives))
  })

  it('handles duplicate scores correctly (FPR jumps by more than one step)', () => {
    const negatives = [0.9, 0.9, 0.9, 0.1, 0.1]
    // Threshold at 0.9 flags all three 0.9s at once: FPR = 3/5 = 0.6.
    expect(fprAt(0.9, negatives)).toBeCloseTo(0.6, 6)
    const t = thresholdForFpr(negatives, 0.6)
    expect(fprAt(t, negatives)).toBeLessThanOrEqual(0.6)
  })

  it('returns +Infinity when there are no negatives to calibrate against', () => {
    expect(thresholdForFpr([], 0.05)).toBe(Number.POSITIVE_INFINITY)
  })

  it('a higher target FPR never yields a stricter (higher) threshold than a lower one', () => {
    const negatives = [0.95, 0.8, 0.6, 0.55, 0.4, 0.3, 0.2, 0.1]
    const strict = thresholdForFpr(negatives, 0.01)
    const loose = thresholdForFpr(negatives, 0.5)
    expect(loose).toBeLessThanOrEqual(strict)
  })
})

describe('recallByCategory', () => {
  it('computes recall independently per category at a fixed threshold', () => {
    const samples = [
      { score: 0.9, category: 'direct_override' },
      { score: 0.8, category: 'direct_override' },
      { score: 0.3, category: 'polite_subtle' },
      { score: 0.2, category: 'polite_subtle' },
    ]
    const r = recallByCategory(0.5, samples)
    expect(r).toEqual({ direct_override: 1, polite_subtle: 0 })
  })

  it('returns an empty object for an empty sample list', () => {
    expect(recallByCategory(0.5, [])).toEqual({})
  })
})
