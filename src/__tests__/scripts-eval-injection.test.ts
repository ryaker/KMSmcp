/**
 * Pure-helper tests for the injection eval script: state building, fingerprinting, the
 * cache path/loader, per-variant metric computation, the needs-human-review list, and the
 * recommendation ranking. No Jev, no network, no file I/O against real fixtures.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildVariantState,
  cachePathForVariant,
  computeVariantReport,
  fingerprintVariantState,
  loadVariantCache,
  needsHumanReview,
  recommendVariant,
  type CachedVariantAnswer,
  type VariantReport,
} from '../scripts/eval-injection.js'
import { INJECTION_EVAL_SCHEMA_VERSION, findVariant } from '../eval/injectionQuestions.js'
import type { InjectionSample } from '../eval/injectionDataset.js'

describe('buildVariantState / fingerprintVariantState', () => {
  it('V0 (useCandidateContentState) nests under candidate.content', () => {
    const v0 = findVariant('v0_contains_instruction')
    expect(buildVariantState(v0, 'hello')).toEqual({ candidate: { content: 'hello' } })
  })

  it('every other variant uses a flat entry field', () => {
    for (const id of ['v1_rag_cookbook', 'v2_precise', 'v3_decomposed', 'v4_decomposed_hidden']) {
      expect(buildVariantState(findVariant(id), 'hello')).toEqual({ entry: 'hello' })
    }
  })

  it('fingerprints differ across variants for the same text (different question set/state shape)', () => {
    const v0 = findVariant('v0_contains_instruction')
    const v2 = findVariant('v2_precise')
    const fp0 = fingerprintVariantState(v0, buildVariantState(v0, 'same text'))
    const fp2 = fingerprintVariantState(v2, buildVariantState(v2, 'same text'))
    expect(fp0).not.toBe(fp2)
  })

  it('fingerprints are stable for the same variant + text', () => {
    const v2 = findVariant('v2_precise')
    const state = buildVariantState(v2, 'stable text')
    expect(fingerprintVariantState(v2, state)).toBe(fingerprintVariantState(v2, state))
  })
})

describe('cachePathForVariant / loadVariantCache', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-injection-cache-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('names the file injection-<variant-id>.json under the cache dir', () => {
    expect(cachePathForVariant('v2_precise', tmpDir)).toBe(path.join(tmpDir, 'injection-v2_precise.json'))
  })

  it('returns an empty cache when the file does not exist', () => {
    const cache = loadVariantCache(path.join(tmpDir, 'missing.json'), 'v2_precise')
    expect(cache).toEqual({ schema_version: INJECTION_EVAL_SCHEMA_VERSION, variant_id: 'v2_precise', entries: {} })
  })

  it('rejects a cache file for a different schema version or variant, starting fresh', () => {
    const filePath = path.join(tmpDir, 'stale.json')
    fs.writeFileSync(filePath, JSON.stringify({ schema_version: 'injection-eval/v0', variant_id: 'v2_precise', entries: { x: {} } }))
    const cache = loadVariantCache(filePath, 'v2_precise')
    expect(cache.entries).toEqual({})
  })

  it('loads a matching cache file as-is', () => {
    const filePath = path.join(tmpDir, 'ok.json')
    const entry: CachedVariantAnswer = {
      probabilities: { injection: 0.42 },
      score: 0.42,
      model: 'jev-1.13.0',
      input_tokens: 100,
      output_tokens: 0,
      cost_usd_estimate: 0.000004,
    }
    fs.writeFileSync(
      filePath,
      JSON.stringify({ schema_version: INJECTION_EVAL_SCHEMA_VERSION, variant_id: 'v2_precise', entries: { fp1: entry } })
    )
    const cache = loadVariantCache(filePath, 'v2_precise')
    expect(cache.entries.fp1).toEqual(entry)
  })
})

describe('computeVariantReport', () => {
  const variant = findVariant('v2_precise')

  function sample(over: Partial<InjectionSample>): InjectionSample {
    return { id: 'x', content: 'c', label: 'positive', source: 'synthetic', category: null, ...over }
  }

  function result(s: InjectionSample, score: number | null) {
    return {
      pair: { variant, sample: s },
      answer:
        score === null
          ? null
          : ({
              probabilities: { injection: score },
              score,
              model: 'jev-1.13.0',
              input_tokens: 50,
              output_tokens: 0,
              cost_usd_estimate: 0.000002,
            } as CachedVariantAnswer),
      error: score === null ? 'engine fault' : null,
      fromCache: false,
    }
  }

  it('separates positives and negatives cleanly into a high AUC with a sane operating point', () => {
    const positives = [
      sample({ id: 'p1', label: 'positive', category: 'direct_override' }),
      sample({ id: 'p2', label: 'positive', category: 'direct_override' }),
      sample({ id: 'p3', label: 'positive', category: 'polite_subtle' }),
    ]
    const syntheticNegatives = [
      sample({ id: 'n1', label: 'negative', source: 'synthetic' }),
      sample({ id: 'n2', label: 'negative', source: 'synthetic' }),
    ]
    const realNegatives = Array.from({ length: 20 }, (_, i) => sample({ id: `r${i}`, label: 'negative', source: 'real' }))

    const results = [
      ...positives.map(p => result(p, 0.95)),
      ...syntheticNegatives.map(n => result(n, 0.05)),
      ...realNegatives.map(n => result(n, 0.05)),
    ]

    const report = computeVariantReport(variant, results)
    expect(report.judged).toBe(results.length)
    expect(report.failed).toBe(0)
    expect(report.auc).toBeCloseTo(1, 6)
    const at1pct = report.operatingPoints.find(p => p.targetFpr === 0.01)!
    expect(at1pct.recall).toBeCloseTo(1, 6)
    expect(at1pct.syntheticHardNegativeFpr).toBe(0)
    expect(report.recallByCategoryAtPrimary).toEqual({ direct_override: 1, polite_subtle: 1 })
  })

  it('counts engine faults as failed and excludes them from judged scoring', () => {
    const positives = [sample({ id: 'p1', label: 'positive', category: 'direct_override' })]
    const realNegatives = [sample({ id: 'r1', label: 'negative', source: 'real' })]
    const results = [result(positives[0], null), result(realNegatives[0], 0.1)]
    const report = computeVariantReport(variant, results)
    expect(report.judged).toBe(1)
    expect(report.failed).toBe(1)
  })
})

describe('needsHumanReview', () => {
  const variant = findVariant('v2_precise')

  function mkResult(id: string, source: InjectionSample['source'], score: number) {
    const sampleObj: InjectionSample = { id, content: 'c', label: 'negative', source, category: null }
    return {
      pair: { variant, sample: sampleObj },
      answer: {
        probabilities: { injection: score },
        score,
        model: 'jev-1.13.0',
        input_tokens: 10,
        output_tokens: 0,
        cost_usd_estimate: 0.0000004,
      } as CachedVariantAnswer,
      error: null,
      fromCache: false,
    }
  }

  it('flags only real samples scored strictly above 0.9, deduplicated and sorted', () => {
    const results = [
      mkResult('r2', 'real', 0.95),
      mkResult('r1', 'real', 0.91),
      mkResult('r1', 'real', 0.92), // same id from a different variant run — dedup
      mkResult('r3', 'real', 0.9), // exactly at threshold — excluded
      mkResult('syn1', 'synthetic', 0.99), // not a real sample — excluded
    ]
    expect(needsHumanReview(results)).toEqual(['r1', 'r2'])
  })

  it('returns an empty array when nothing crosses the bar', () => {
    expect(needsHumanReview([mkResult('r1', 'real', 0.5)])).toEqual([])
  })
})

describe('recommendVariant', () => {
  function report(over: Partial<VariantReport>): VariantReport {
    return {
      variantId: 'x',
      label: 'x',
      judged: 10,
      failed: 0,
      auc: 0.5,
      operatingPoints: [
        { targetFpr: 0.01, threshold: 0.9, recall: 0.5, syntheticHardNegativeFpr: 0, realDirectiveLikeFpr: 0 },
        { targetFpr: 0.05, threshold: 0.8, recall: 0.7, syntheticHardNegativeFpr: 0, realDirectiveLikeFpr: 0 },
      ],
      recallByCategoryAtPrimary: {},
      primaryTargetFpr: 0.01,
      ...over,
    }
  }

  it('picks the higher-AUC variant', () => {
    const a = report({ variantId: 'low', auc: 0.7 })
    const b = report({ variantId: 'high', auc: 0.95 })
    expect(recommendVariant([a, b])?.variantId).toBe('high')
  })

  it('breaks an AUC tie by recall at the 1% FPR operating point', () => {
    const a = report({
      variantId: 'lower-recall',
      auc: 0.9,
      operatingPoints: [
        { targetFpr: 0.01, threshold: 0.9, recall: 0.4, syntheticHardNegativeFpr: 0, realDirectiveLikeFpr: 0 },
        { targetFpr: 0.05, threshold: 0.8, recall: 0.6, syntheticHardNegativeFpr: 0, realDirectiveLikeFpr: 0 },
      ],
    })
    const b = report({
      variantId: 'higher-recall',
      auc: 0.9,
      operatingPoints: [
        { targetFpr: 0.01, threshold: 0.85, recall: 0.6, syntheticHardNegativeFpr: 0, realDirectiveLikeFpr: 0 },
        { targetFpr: 0.05, threshold: 0.75, recall: 0.8, syntheticHardNegativeFpr: 0, realDirectiveLikeFpr: 0 },
      ],
    })
    expect(recommendVariant([a, b])?.variantId).toBe('higher-recall')
  })

  it('treats NaN AUC (no usable results) as worse than any real number', () => {
    const nanReport = report({ variantId: 'nan', auc: NaN })
    const okReport = report({ variantId: 'ok', auc: 0.5 })
    expect(recommendVariant([nanReport, okReport])?.variantId).toBe('ok')
  })

  it('returns null for an empty report list', () => {
    expect(recommendVariant([])).toBeNull()
  })
})
