/**
 * LIVE smoke test — real requests to TypeSafe through whatever credential route the
 * environment provides (the OneCLI gateway, or TYPESAFE_API_KEY).
 *
 * Skipped unless KMS_JEV_LIVE_SMOKE=1, so CI and an ordinary `npm test` never touch the
 * network or spend tokens. To run on this machine, with the gateway up (`onecli status`):
 *
 *   set -a; source ~/nanobanana-mcp-server-local/.env; set +a   # ONECLI_TOKEN, ONECLI_GATEWAY
 *   KMS_JEV_LIVE_SMOKE=1 npx jest src/__tests__/decision-JevDecisionEngine.live.test.ts
 *
 * Asserts the wire contract and one unambiguous ordering — not calibration. Whether the
 * judgments are any good on the real corpus is what the shadow log is for.
 */

import { createJevDecisionEngineFromEnv } from '../decision/JevDecisionEngine.js'
import { EVIDENCE_VALUE_LEVELS, RECALL_STATUS_OPTIONS } from '../decision/recallEvidence.js'
import { runShadowRerank } from '../decision/shadowRerank.js'

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
})
