/**
 * Tests for the shadow eval metrics module.
 *
 * The promote gate is a sample count, and a count is only as good as the reader that
 * produced it. These pin the reader: that it tolerates a log being appended to while it
 * reads, that it separates "no ordering was computed" from "the line is broken", that it
 * catches a non-permutation, and — most importantly — that it returns **null** rather than
 * a flattering zero when there are no relevance labels.
 */

import {
  labelAgreement,
  orderingMetrics,
  parseLabels,
  parseShadowLog,
  protectionAudit,
  rateProjection,
  renderReport,
  runTotals,
  summarize,
  unmatchedLabelKeys
} from '../eval/shadowRunMetrics.js'
import type { CandidateDecisionRecord, ShadowRunRecord } from '../decision/decisionLog.js'

// ── fixtures ─────────────────────────────────────────────────────────────────

function cand(id: string, over: Partial<CandidateDecisionRecord> = {}): CandidateDecisionRecord {
  return {
    id,
    production_rank: 1,
    state_fingerprint: `fp-${id}`,
    content_truncated: false,
    retrieval: {
      source_systems: ['mongodb'],
      retrieval_relevance: 0.1,
      vector_similarity: 0.5,
      ontology_score: 0.0,
      knowledge_confidence: 0.8
    },
    jev: null,
    policy_protected: null,
    policy_shadow_score: 0.5,
    policy_shadow_rank: 1,
    model: 'jev-1.13.0',
    request_id: null,
    latency_ms: 100,
    usage: { input_tokens: 10, output_tokens: 2 },
    cost_usd_estimate: 0.001,
    error: null,
    ...over
  }
}

function run(over: Partial<ShadowRunRecord> = {}): ShadowRunRecord {
  return {
    kind: 'recall_shadow_run',
    at: '2026-09-20T00:00:00.000Z',
    run_id: 'run-1',
    provider: 'typesafe',
    requested_model: 'jev-latest',
    models: ['jev-1.13.0'],
    question_schema_version: 'v1',
    policy_version: 'recall-shadow-policy/v1',
    policy_decision: 'shadow_reorder',
    query: 'what did we decide about the dedup gate',
    candidates_in_pool: 3,
    candidates_evaluated: 3,
    candidates_failed: 0,
    latency_ms: 1000,
    usage: { input_tokens: 100, output_tokens: 10 },
    cost_usd_estimate: 0.001,
    production_order: ['a', 'b', 'c'],
    shadow_order: ['a', 'b', 'c'],
    candidates: [cand('a'), cand('b'), cand('c')],
    ...over
  }
}

const line = (r: unknown): string => JSON.stringify(r) + '\n'

// ── parsing ──────────────────────────────────────────────────────────────────

describe('parseShadowLog — lenient by design', () => {
  it('parses well-formed recall runs and ignores blank lines', () => {
    const p = parseShadowLog('\n' + line(run()) + '\n' + line(run({ run_id: 'run-2' })))
    expect(p.rows.map(r => r.run_id)).toEqual(['run-1', 'run-2'])
    expect(p.malformedLines).toBe(0)
    expect(p.partialTailLines).toBe(0)
  })

  it('counts a corrupt interior line as malformed and keeps reading past it', () => {
    const p = parseShadowLog(
      line(run({ run_id: 'run-1' })) + '{not json\n' + line(run({ run_id: 'run-3' }))
    )
    expect(p.rows.map(r => r.run_id)).toEqual(['run-1', 'run-3'])
    expect(p.malformedLines).toBe(1)
  })

  it('counts a broken FINAL line as a partial tail, not corruption', () => {
    // The live log is appended to by a daemon; the last line is routinely mid-write.
    const p = parseShadowLog(line(run()) + '{"kind":"recall_shadow_r')
    expect(p.rows).toHaveLength(1)
    expect(p.partialTailLines).toBe(1)
    expect(p.malformedLines).toBe(0)
  })

  it('separates a shadow_log run (no ordering) from a malformed line', () => {
    const p = parseShadowLog(
      line(run({ policy_decision: 'shadow_log', shadow_order: null })) +
        line(run({ run_id: 'run-2' }))
    )
    expect(p.rows.map(r => r.run_id)).toEqual(['run-2'])
    expect(p.unorderedRuns).toBe(1)
    expect(p.malformedLines).toBe(0)
  })

  it('rejects a well-formed JSON line that is not a recall run', () => {
    const p = parseShadowLog(line({ kind: 'write_dedup_shadow_run' }))
    expect(p.rows).toHaveLength(0)
    expect(p.malformedLines).toBe(1)
  })

  it('returns nothing for empty input rather than throwing', () => {
    expect(parseShadowLog('')).toEqual({
      rows: [],
      malformedLines: 0,
      partialTailLines: 0,
      unorderedRuns: 0
    })
  })
})

// ── ordering metrics ─────────────────────────────────────────────────────────

describe('orderingMetrics', () => {
  it('reports an unchanged run as identical, not reordered', () => {
    const m = orderingMetrics([
      run({ production_order: ['a', 'b', 'c'], shadow_order: ['a', 'b', 'c'] })
    ])
    expect(m.identical).toBe(1)
    expect(m.reordered).toBe(0)
    expect(m.reorderRate).toBe(0)
    expect(m.top1Agreement).toBe(1)
    expect(m.top3SetEqual).toBe(1)
    expect(m.meanDisplacement).toBe(0)
  })

  it('counts a swap below the top as reordered, and measures the displacement', () => {
    const m = orderingMetrics([
      run({ production_order: ['a', 'b', 'c'], shadow_order: ['a', 'c', 'b'] })
    ])
    expect(m.reorderRate).toBe(1)
    expect(m.top1Agreement).toBe(1) // rank 1 unchanged
    expect(m.top3SetEqual).toBe(1) // same SET, different order
    expect(m.meanDisplacement).toBeCloseTo(2 / 3) // b:1, c:1, a:0 over 3 candidates
    expect(m.permutationViolations).toBe(0)
  })

  it('does not call a top-3 a set match when one member was pushed out', () => {
    const m = orderingMetrics([
      run({
        production_order: ['a', 'b', 'c', 'd'],
        shadow_order: ['a', 'b', 'd', 'c']
      })
    ])
    expect(m.top1Agreement).toBe(1)
    expect(m.top3SetEqual).toBe(0) // {a,b,c} vs {a,b,d} — one member pushed out
    expect(m.meanTop3Overlap).toBeCloseTo(2 / 3)
  })

  it('catches a shadow order that is not a permutation — the invariant that must be 0', () => {
    const m = orderingMetrics([
      run({ production_order: ['a', 'b', 'c'], shadow_order: ['a', 'b'] })
    ])
    expect(m.permutationViolations).toBe(1)
  })

  it('catches a duplicate id masquerading as a permutation', () => {
    const m = orderingMetrics([
      run({ production_order: ['a', 'b', 'c'], shadow_order: ['a', 'b', 'b'] })
    ])
    expect(m.permutationViolations).toBe(1)
  })

  it('skips empty runs from the overlap average instead of scoring them as disagreeing', () => {
    const m = orderingMetrics([
      run({ production_order: [], shadow_order: [] }),
      run({ production_order: ['a'], shadow_order: ['a'] })
    ])
    expect(m.emptyRuns).toBe(1)
    expect(m.meanTop3Overlap).toBeCloseTo(1 / 3) // the non-empty run only: |{a} ∩ {a}| / 3
  })

  it('returns zeros for no runs rather than NaN', () => {
    const m = orderingMetrics([])
    expect(m.reorderRate).toBe(0)
    expect(m.meanDisplacement).toBe(0)
    expect(Number.isNaN(m.top1Agreement)).toBe(false)
  })
})

// ── protection invariant ─────────────────────────────────────────────────────

describe('protectionAudit — invariant 2', () => {
  it('flags a protected candidate placed BELOW its production position', () => {
    const r = run({
      production_order: ['a', 'b', 'c'],
      shadow_order: ['b', 'a', 'c'],
      candidates: [
        cand('a', {
          production_rank: 1,
          policy_protected: 'ontology_match',
          retrieval: { ...cand('a').retrieval, ontology_score: 0.95 }
        }),
        cand('b', { production_rank: 2 }),
        cand('c', { production_rank: 3 })
      ]
    })
    const audit = protectionAudit([r])
    expect(audit.fired).toBe(1)
    expect(audit.violations).toHaveLength(1)
    expect(audit.violations[0]).toMatchObject({
      candidateId: 'a',
      productionRank: 1,
      shadowRank: 2
    })
    expect(audit.violatedRuns).toEqual(['run-1'])
  })

  it('accepts a protected candidate that was promoted', () => {
    const r = run({
      production_order: ['a', 'b', 'c'],
      shadow_order: ['c', 'a', 'b'],
      candidates: [
        cand('a', { production_rank: 1 }),
        cand('b', { production_rank: 2 }),
        cand('c', {
          production_rank: 3,
          policy_protected: 'lexical_match',
          retrieval: { ...cand('c').retrieval, retrieval_relevance: 0.9 }
        })
      ]
    })
    const audit = protectionAudit([r])
    expect(audit.fired).toBe(1)
    expect(audit.byReason).toEqual({ lexical_match: 1 })
    expect(audit.violations).toHaveLength(0)
    expect(audit.disagreements).toBe(0)
  })

  it('re-derives policy_protected from the logged signals and counts drift', () => {
    // Logged flag says protected; the signals it claims to come from say otherwise.
    const r = run({
      candidates: [
        cand('a', {
          production_rank: 1,
          policy_protected: 'ontology_match',
          retrieval: {
            ...cand('a').retrieval,
            ontology_score: 0.1,
            retrieval_relevance: 0.1
          }
        })
      ]
    })
    const audit = protectionAudit([r])
    expect(audit.disagreements).toBe(1)
    expect(audit.disagreementExamples[0]).toContain('logged=ontology_match derived=null')
  })

  it('does not report a violation when the shadow ordering omits the candidate', () => {
    // A missing id is caught by permutationViolations, not double-counted here.
    const r = run({
      production_order: ['a', 'b'],
      shadow_order: ['b'],
      candidates: [
        cand('a', {
          production_rank: 1,
          policy_protected: 'ontology_match',
          retrieval: { ...cand('a').retrieval, ontology_score: 0.9 }
        }),
        cand('b', { production_rank: 2 })
      ]
    })
    const audit = protectionAudit([r])
    expect(audit.violations).toHaveLength(0)
  })

  it('reports fired=0 on a corpus where the thresholds never trigger', () => {
    const audit = protectionAudit([run(), run({ run_id: 'run-2' })])
    expect(audit.candidates).toBe(6)
    expect(audit.fired).toBe(0)
    expect(audit.disagreements).toBe(0)
  })
})

// ── totals ───────────────────────────────────────────────────────────────────

describe('runTotals', () => {
  it('sums cost, tokens and candidate faults', () => {
    const t = runTotals([
      run({ latency_ms: 100, cost_usd_estimate: 0.002 }),
      run({
        latency_ms: 300,
        cost_usd_estimate: 0.004,
        candidates_failed: 1,
        run_id: 'run-2'
      })
    ])
    expect(t.meanLatencyMs).toBe(200)
    expect(t.maxLatencyMs).toBe(300)
    expect(t.totalCostUsd).toBeCloseTo(0.006)
    expect(t.meanCostUsd).toBeCloseTo(0.003)
    expect(t.costedRuns).toBe(2)
    expect(t.candidatesFailed).toBe(1)
    expect(t.candidatesEvaluated).toBe(6)
  })

  it('counts a costed run separately from the run count when prices were unset', () => {
    const t = runTotals([run({ cost_usd_estimate: null })])
    expect(t.runs).toBe(1)
    expect(t.costedRuns).toBe(0)
    expect(t.meanCostUsd).toBe(0)
  })

  it('counts per-candidate error strings, which is where a provider fault lands', () => {
    const t = runTotals([run({ candidates: [cand('a', { error: 'timeout' }), cand('b')] })])
    expect(t.candidateErrors).toBe(1)
  })
})

// ── rate projection ──────────────────────────────────────────────────────────

describe('rateProjection', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h, 0, 0)).toISOString()

  it('extrapolates an ETA from an observed window', () => {
    const rows = [0, 6, 12, 18].map(h => run({ at: at(h) }))
    const r = rateProjection(rows, 200)
    expect(r.windowHours).toBeCloseTo(18)
    expect(r.runsPerDay).toBeCloseTo((4 / 18) * 24)
    expect(r.remaining).toBe(196)
    expect(r.etaHours!).toBeCloseTo(196 / (((4 / 18) * 24) / 24))
  })

  it('refuses to extrapolate below an hour of observation', () => {
    const rows = [run({ at: at(0) }), run({ at: at(0) })]
    const r = rateProjection(rows, 200)
    expect(r.etaHours).toBeNull()
    expect(r.etaAt).toBeNull()
  })

  it('counts per UTC day so a burst on one day is visible', () => {
    const r = rateProjection([run({ at: at(1) }), run({ at: at(2) }), run({ at: at(25) })], 200)
    expect(r.perUtcDay).toEqual({ '2026-09-20': 2, '2026-09-21': 1 })
  })

  it('reports remaining=0 once the target is met', () => {
    const r = rateProjection([run()], 1)
    expect(r.remaining).toBe(0)
  })

  it('handles an empty set without NaN', () => {
    const r = rateProjection([], 200)
    expect(r.remaining).toBe(200)
    expect(r.firstAt).toBeNull()
    expect(Number.isNaN(r.windowHours)).toBe(false)
  })
})

// ── label join ───────────────────────────────────────────────────────────────

describe('parseLabels', () => {
  it('reads the JSONL shape', () => {
    const s = parseLabels(line({ query: 'q1', labels: { a: 1, b: 0 } }))
    expect(s).toEqual({ q1: { a: 1, b: 0 } })
  })

  it('reads the single-JSON-object shape keyed by query', () => {
    expect(parseLabels(JSON.stringify({ q1: { a: 1 } }))).toEqual({
      q1: { a: 1 }
    })
  })

  it('returns an empty set for empty input — distinct from "no labels file given"', () => {
    expect(parseLabels('')).toEqual({})
  })

  it('throws on a genuinely corrupt JSONL line rather than silently dropping it', () => {
    expect(() => parseLabels('{oops\n')).toThrow(/not JSON/)
  })
})

describe('labelAgreement — must never invent a relevance judgment', () => {
  it('returns null when no run carries a label', () => {
    expect(labelAgreement([run()], {}, 5)).toBeNull()
    expect(labelAgreement([run()], { 'some other query': { a: 1 } }, 5)).toBeNull()
  })

  it('scores the shadow ordering against production on labeled runs', () => {
    const rows = [
      run({
        query: 'q1',
        production_order: ['a', 'b', 'c'], // relevant hit 'b' at rank 2
        shadow_order: ['c', 'a', 'b'] // same set, but 'b' demoted to rank 3
      })
    ]
    const a = labelAgreement(rows, { q1: { b: 1, a: 0, c: 0 } }, 3)!
    expect(a.labeledRuns).toBe(1)
    expect(a.production.reciprocalRank).toBeCloseTo(0.5)
    expect(a.shadow.reciprocalRank).toBeCloseTo(1 / 3)
    expect(a.production.meanFirstRelevantRank).toBe(2)
    expect(a.shadow.meanFirstRelevantRank).toBe(3)
    expect(a.delta.reciprocalRank).toBeLessThan(0)
  })

  it('reports a negative delta when the shadow ordering pushes the relevant hit down', () => {
    const rows = [
      run({
        query: 'q1',
        production_order: ['b', 'a', 'c'],
        shadow_order: ['a', 'c', 'b']
      })
    ]
    const a = labelAgreement(rows, { q1: { b: 1 } }, 3)!
    expect(a.production.reciprocalRank).toBeCloseTo(1)
    expect(a.shadow.reciprocalRank).toBeCloseTo(1 / 3)
    expect(a.delta.reciprocalRank).toBeLessThan(0)
  })

  it('excludes and counts unlabeled runs rather than scoring them as zero', () => {
    const rows = [
      run({
        query: 'q1',
        run_id: 'run-1',
        production_order: ['b', 'a', 'c'],
        shadow_order: ['b', 'a', 'c']
      }),
      run({ query: 'q-unlabeled', run_id: 'run-2' })
    ]
    const a = labelAgreement(rows, { q1: { b: 1 } }, 3)!
    expect(a.labeledRuns).toBe(1)
    expect(a.unlabeledRuns).toBe(1)
    expect(a.production.reciprocalRank).toBeCloseTo(1)
  })
})

describe('unmatchedLabelKeys', () => {
  it('names an unmatched label key by hash and length, never by text', () => {
    const out = unmatchedLabelKeys({ 'never ran this': { a: 1 } }, [run({ query: 'ran this' })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^sha256:[0-9a-f]{12} {2}len=14$/)
    expect(out[0]).not.toContain('never')
  })

  it('matches on trimmed query text, so trailing whitespace is not a false mismatch', () => {
    expect(unmatchedLabelKeys({ 'ran this': { a: 1 } }, [run({ query: '  ran this  ' })])).toEqual(
      []
    )
  })
})

// ── rendering ────────────────────────────────────────────────────────────────

describe('renderReport — must not let a missing label set read as a zero', () => {
  const summary = summarize([run()], { target: 200, k: 5 })

  it('states the label absence explicitly', () => {
    const text = renderReport(
      [
        {
          label: 'eng',
          file: '/tmp/x.jsonl',
          parsed: parseShadowLog(line(run()))
        }
      ],
      summary,
      {
        labelSetProvided: false
      }
    )
    expect(text).toContain('labels')
    expect(text).toContain('NONE — quality delta NOT computed')
  })

  it('titles the quality section as change, not improvement', () => {
    const text = renderReport([], summary, { labelSetProvided: false })
    expect(text).toContain('QUALITY — how much the policy would change; NOT whether it is better')
    expect(text).not.toMatch(/improvement/i)
  })

  it('marks an unreadable log as MISSING rather than reporting zero runs', () => {
    const text = renderReport(
      [{ label: 'personal', file: '/tmp/gone.jsonl', parsed: null }],
      summary,
      {
        labelSetProvided: false
      }
    )
    expect(text).toContain('MISSING')
  })

  it('prints the gate, the invariants and the shadow-only reminder', () => {
    const text = renderReport([], summary, { labelSetProvided: false })
    expect(text).toContain('1 / 200 target')
    expect(text).toContain('INVARIANTS — must hold at any sample count')
    expect(text).toContain('shadow-only. Nothing here changes what unified_search returns.')
  })

  it('adds the label rows only when labels produced scores', () => {
    const without = renderReport([], summary, { labelSetProvided: true })
    expect(without).not.toContain('nDCG@5')
    const rows = [
      run({
        query: 'q1',
        production_order: ['b', 'a'],
        shadow_order: ['a', 'b'],
        candidates: [cand('a'), cand('b')]
      })
    ]
    const withLabels = summarize(rows, {
      target: 200,
      k: 5,
      labels: { q1: { b: 1 } }
    })
    expect(renderReport([], withLabels, { labelSetProvided: true })).toContain('nDCG@5')
  })

  it('never prints query text', () => {
    const secret = 'sk-live-DEADBEEF'
    const rows = [run({ query: secret })]
    const text = renderReport([], summarize(rows, { target: 200 }), {
      labelSetProvided: false
    })
    expect(text).not.toContain(secret)
  })

  it('warns when the protection rule never fired on live data', () => {
    const text = renderReport([], summary, { labelSetProvided: false })
    expect(text).toContain('never fired')
  })
})
