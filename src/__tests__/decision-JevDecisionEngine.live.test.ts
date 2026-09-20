/**
 * LIVE smoke test — real requests to TypeSafe through whatever credential route the
 * environment provides (the OneCLI gateway, or TYPESAFE_API_KEY).
 *
 * Skipped unless KMS_JEV_LIVE_SMOKE=1, so CI and an ordinary `npm test` never touch the
 * network or spend tokens. To run on this machine, with the gateway up (`onecli status`):
 *
 *   KMS_JEV_LIVE_SMOKE=1 doppler run -p ry-local -c dev_personal -- \
 *     npx jest src/__tests__/decision-JevDecisionEngine.live.test.ts   # ONECLI_TOKEN, ONECLI_GATEWAY
 *
 * Asserts the wire contract and one unambiguous ordering — not calibration. Whether the
 * judgments are any good on the real corpus is what the shadow log is for.
 */

import { createJevDecisionEngineFromEnv } from '../decision/JevDecisionEngine.js'
import { EVIDENCE_VALUE_LEVELS, RECALL_STATUS_OPTIONS } from '../decision/recallEvidence.js'
import { runShadowRerank } from '../decision/shadowRerank.js'
import { WRITE_DEDUP_NOULS, WRITE_DEDUP_RELATIONS } from '../decision/writeDedupRelation.js'
import { runWriteDedupShadow } from '../decision/writeDedupShadow.js'

const live = process.env.KMS_JEV_LIVE_SMOKE === '1' ? describe : describe.skip

live('Jev live smoke', () => {
  it('judges a three-candidate pool end to end', async () => {
    const engine = createJevDecisionEngineFromEnv()
    if (!engine) throw new Error('KMS_JEV_LIVE_SMOKE=1 but no credential route: set ONECLI_TOKEN+ONECLI_GATEWAY or TYPESAFE_API_KEY')

    const run = await runShadowRerank({
      engine,
      query: 'How many cameras does the Phoenix rig use?',
      action: 'shadow_reorder',
      ranked: [
        { id: 'noise', content: 'Session notes: discussed the Phoenix arena parking situation and lunch options.', contentType: 'memory', timestamp: '2026-09-01T00:00:00Z' },
        { id: 'stale', content: 'As of the March calibration the Phoenix rig had 6 cameras. This was later found to be wrong.', contentType: 'fact', timestamp: '2026-03-10T00:00:00Z', superseded_by: 'answer' },
        { id: 'answer', content: 'The Phoenix rig uses 16 cameras, confirmed against the canvas bounds in the September calibration.', contentType: 'fact', timestamp: '2026-09-12T00:00:00Z', metadata: { supersedes: 'stale' } },
      ],
    })

    // Surface the judgments in the test output — this is a smoke test, the numbers are
    // the point. Ids, probabilities and usage only; no credentials pass through here.
    console.error(JSON.stringify({
      models: run.models, latency_ms: run.latency_ms, usage: run.usage, cost_usd_estimate: run.cost_usd_estimate,
      shadow_order: run.shadow_order,
      candidates: run.candidates.map(c => ({ id: c.id, error: c.error, latency_ms: c.latency_ms, shadow_score: c.policy_shadow_score, jev: c.jev })),
    }, null, 2))

    expect(run.candidates.map(c => c.error)).toEqual([null, null, null])
    expect(run.models).toHaveLength(1)
    expect(run.usage.input_tokens).toBeGreaterThan(0)
    for (const c of run.candidates) {
      expect(c.jev!.answers_query.jev_probability).toBeGreaterThanOrEqual(0)
      expect(c.jev!.answers_query.jev_probability).toBeLessThanOrEqual(1)
      expect(Object.keys(c.jev!.status.jev_probabilities).sort()).toEqual([...RECALL_STATUS_OPTIONS].sort())
      expect(Object.keys(c.jev!.evidence_value.jev_probabilities).sort()).toEqual([...EVIDENCE_VALUE_LEVELS].sort())
    }
    expect(run.shadow_order![0]).toBe('answer')
    expect(run.shadow_order![2]).toBe('noise')
  }, 60_000)
  // Experiment 2. Six pairs, one per relation, each written to be
  // unambiguous — this checks the wire contract and that the questions are not read
  // backwards, not calibration.
  it('classifies write-dedup pairs end to end', async () => {
    const engine = createJevDecisionEngineFromEnv()
    if (!engine) throw new Error('KMS_JEV_LIVE_SMOKE=1 but no credential route: set ONECLI_TOKEN+ONECLI_GATEWAY or TYPESAFE_API_KEY')

    const stored: Record<string, string> = {
      duplicate: 'The Phoenix rig uses 16 cameras.',
      supersedes: 'The Phoenix rig uses 6 cameras.',
      supersedes_reverse: 'Correction: the Phoenix rig uses 16 cameras, not 6. The earlier 6-camera figure was wrong — it used the wrong zoom config.',
      contradicts: 'The Phoenix rig runs entirely on battery power and has no mains connection.',
      complement: 'The Phoenix rig uses 16 cameras.',
      unrelated: 'Rich prefers asynchronous communication over real-time meetings.',
    }
    const incoming: Record<string, string> = {
      duplicate: 'Phoenix rig camera count: 16.',
      supersedes: 'Correction: the Phoenix rig uses 16 cameras, not 6. The earlier 6-camera figure was wrong — it used the wrong zoom config.',
      supersedes_reverse: 'The Phoenix rig uses 6 cameras.',
      contradicts: 'The Phoenix rig is powered from mains and has no battery.',
      complement: 'The 16 Phoenix rig cameras are arranged in a 4x4 grid with 12 cm spacing.',
      unrelated: 'The Phoenix rig uses 16 cameras.',
    }

    const summary: Record<string, unknown> = {}
    for (const expected of Object.keys(stored)) {
      const run = await runWriteDedupShadow({
        engine,
        assertion: { entryId: `new-${expected}`, content: incoming[expected], contentType: 'fact' },
        gate: { outcome: 'dedup_required', band: 'confirm', thresholds: { refuse: 0.88, confirm: 0.78 } },
        candidates: [{ id: `old-${expected}`, vectorSimilarity: 0.84, tier2Relation: null, contentPreview: stored[expected], contentType: 'fact' }],
      })
      const [c] = run.candidates
      summary[expected] = {
        error: c.error, latency_ms: c.latency_ms, usage: c.usage, model: c.model,
        relation: c.jev?.relation, nouls: c.jev?.nouls, policy_proposal: c.policy_proposal, policy_reasons: c.policy_reasons,
      }

      expect(c.error).toBeNull()
      expect(Object.keys(c.jev!.relation.jev_probabilities).sort()).toEqual([...WRITE_DEDUP_RELATIONS].sort())
      expect(Object.keys(c.jev!.nouls).sort()).toEqual([...WRITE_DEDUP_NOULS].sort())
      expect(run.policy_decision).toBe('shadow_log')
    }
    // Ids, probabilities and usage only; no credentials pass through here. Written to
    // stderr directly: setup.ts mocks `console`, which would swallow the numbers.
    process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`)

    const relationOf = (k: string) => (summary[k] as any).relation.choice
    const proposalOf = (k: string) => (summary[k] as any).policy_proposal
    expect(relationOf('unrelated')).toBe('unrelated')
    expect(proposalOf('unrelated')).toBe('store_new')
    // The costly error is a false duplicate: nothing that adds information may be skipped.
    expect(proposalOf('complement')).not.toBe('suggest_skip_duplicate')
    expect(proposalOf('supersedes')).not.toBe('suggest_skip_duplicate')
    // Direction is the dangerous confusion: a stale assertion must never be proposed as
    // the replacement for the entry that corrected it.
    expect(proposalOf('supersedes_reverse')).not.toBe('suggest_supersede')
    expect(proposalOf('supersedes_reverse')).not.toBe('suggest_skip_duplicate')
    // A flat conflict with no correction marker must not be waved through.
    expect(['escalate_contradiction', 'review']).toContain(proposalOf('contradicts'))
  }, 120_000)
})
