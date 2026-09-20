/**
 * JevDecisionEngine against a stubbed System One client — request translation, answer
 * validation, cost estimation, and the env factory's credential routing. No network.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_TIMEOUT_MS,
  JevDecisionEngine,
  createJevDecisionEngineFromEnv,
  jevPricingFromEnv,
  type SystemOneClient,
} from '../decision/JevDecisionEngine.js'
import { createOneCliFetch } from '../decision/onecli.js'
import { JsonlDecisionLog } from '../decision/decisionLog.js'
import type { DecisionRequest } from '../decision/types.js'

const REQUEST: DecisionRequest = {
  state: { query: 'q', candidate: { content: 'c' } },
  questions: {
    answers_query: { type: 'noul', instructions: 'Does it answer?', criteria: { true: 'yes', false: 'no' } },
    status: { type: 'choice', instructions: 'Standing?', criteria: { current: 'now', irrelevant: 'off-topic' } },
    evidence_value: { type: 'score', instructions: 'How much?', criteria: ['none', 'some', 'all'] },
  },
}

const RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    answers_query: { type: 'noul', noul: 0.92 },
    status: { type: 'choice', choice: 'current', probabilities: { current: 0.85, irrelevant: 0.15 }, confidence: 0.82 },
    evidence_value: { type: 'score', score: 1.6, legend: { 0: 'none', 1: 'some', 2: 'all' }, probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 }, confidence: 0.78 },
  },
  usage: { input_tokens: 500_000, output_tokens: 48 },
}

const stubClient = (data: unknown = RESPONSE, requestId: string | undefined = 'req_abc') => {
  const systemOne = jest.fn(() => ({ withResponse: async () => ({ data, requestId }) }))
  return { client: { systemOne } as unknown as SystemOneClient, systemOne }
}

describe('JevDecisionEngine.evaluate', () => {
  it('sends state, questions and the requested model in the SDK shape', async () => {
    const { client, systemOne } = stubClient()
    await new JevDecisionEngine({ client }).evaluate(REQUEST)

    expect(systemOne).toHaveBeenCalledTimes(1)
    const [body, options] = systemOne.mock.calls[0] as unknown as [any, any]
    expect(body.state).toBe(REQUEST.state)
    expect(body.model).toBe(JEV_DEFAULT_MODEL)
    expect(body.questions).toEqual({
      answers_query: { type: 'noul', instructions: 'Does it answer?', criteria: { true: 'yes', false: 'no' } },
      status: { type: 'choice', instructions: 'Standing?', criteria: { current: 'now', irrelevant: 'off-topic' } },
      evidence_value: { type: 'score', instructions: 'How much?', criteria: ['none', 'some', 'all'] },
    })
    expect(options).toEqual({ timeout: JEV_DEFAULT_TIMEOUT_MS })
  })

  it('returns provider-neutral answers with full distributions', async () => {
    const result = await new JevDecisionEngine({ client: stubClient().client }).evaluate(REQUEST)
    expect(result.answers).toEqual({
      answers_query: { type: 'noul', probability: 0.92 },
      status: { type: 'choice', choice: 'current', probabilities: { current: 0.85, irrelevant: 0.15 }, confidence: 0.82 },
      evidence_value: { type: 'score', score: 1.6, probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 }, confidence: 0.78 },
    })
  })

  it('reports the model that answered, not the alias that was asked for', async () => {
    const result = await new JevDecisionEngine({ client: stubClient().client, model: 'jev-latest' }).evaluate(REQUEST)
    expect(result).toMatchObject({ provider: 'typesafe', requestedModel: 'jev-latest', model: 'jev-1.13.0', requestId: 'req_abc' })
    expect(typeof result.latencyMs).toBe('number')
  })

  it('estimates cost from usage and the configured price — output tokens are free by default', async () => {
    const result = await new JevDecisionEngine({ client: stubClient().client }).evaluate(REQUEST)
    expect(result.usage).toEqual({ inputTokens: 500_000, outputTokens: 48 })
    expect(result.costUsdEstimate).toBeCloseTo(0.021, 10)

    const priced = await new JevDecisionEngine({ client: stubClient().client, pricing: { inputPerMtok: 1, outputPerMtok: 1_000_000 } }).evaluate(REQUEST)
    expect(priced.costUsdEstimate).toBeCloseTo(48.5, 10)

    const unpriced = await new JevDecisionEngine({ client: stubClient().client, pricing: null }).evaluate(REQUEST)
    expect(unpriced.costUsdEstimate).toBeNull()
  })

  it('passes a per-request timeout and abort signal through', async () => {
    const { client, systemOne } = stubClient()
    const signal = new AbortController().signal
    await new JevDecisionEngine({ client, timeoutMs: 900 }).evaluate({ ...REQUEST, timeoutMs: 250, signal })
    expect((systemOne.mock.calls[0] as unknown as [any, any])[1]).toEqual({ timeout: 250, signal })
  })

  it.each([
    ['a missing answer', { ...RESPONSE.answers, status: undefined }, /"status" is undefined, expected choice/],
    ['an answer of the wrong kind', { ...RESPONSE.answers, status: { type: 'noul', noul: 0.5 } }, /"status" is noul, expected choice/],
    ['a noul outside [0, 1]', { ...RESPONSE.answers, answers_query: { type: 'noul', noul: 1.2 } }, /noul "answers_query" is not in \[0, 1\]/],
    ['a NaN probability', { ...RESPONSE.answers, status: { ...RESPONSE.answers.status, probabilities: { current: NaN } } }, /probability "current"/],
    ['a choice with no distribution', { ...RESPONSE.answers, status: { type: 'choice', choice: 'current', confidence: 0.8 } }, /has no probabilities/],
    ['a non-finite score', { ...RESPONSE.answers, evidence_value: { ...RESPONSE.answers.evidence_value, score: Infinity } }, /score "evidence_value" is malformed/],
  ])('rejects %s instead of passing it on as a judgment', async (_label, answers, message) => {
    const { client } = stubClient({ ...RESPONSE, answers })
    await expect(new JevDecisionEngine({ client }).evaluate(REQUEST)).rejects.toThrow(message)
  })

  it('propagates a transport failure — an engine never invents an answer', async () => {
    const client = { systemOne: () => ({ withResponse: async () => { throw new Error('ECONNREFUSED') } }) } as unknown as SystemOneClient
    await expect(new JevDecisionEngine({ client }).evaluate(REQUEST)).rejects.toThrow('ECONNREFUSED')
  })

  it('refuses an empty question set and a one-level score before calling out', async () => {
    const { client, systemOne } = stubClient()
    const engine = new JevDecisionEngine({ client })
    await expect(engine.evaluate({ state: 's', questions: {} })).rejects.toThrow(/at least one question/)
    await expect(engine.evaluate({ state: 's', questions: { s: { type: 'score', instructions: 'i', criteria: ['only'] } } })).rejects.toThrow(/at least two levels/)
    expect(systemOne).not.toHaveBeenCalled()
  })
})

describe('jevPricingFromEnv', () => {
  it('defaults to the published Jev price and accepts overrides', () => {
    expect(jevPricingFromEnv({})).toEqual({ inputPerMtok: 0.042, outputPerMtok: 0 })
    expect(jevPricingFromEnv({ KMS_JEV_PRICE_INPUT_PER_MTOK: '0.1', KMS_JEV_PRICE_OUTPUT_PER_MTOK: '0.2' })).toEqual({ inputPerMtok: 0.1, outputPerMtok: 0.2 })
  })

  it('ignores a malformed or negative price rather than estimating with it', () => {
    expect(jevPricingFromEnv({ KMS_JEV_PRICE_INPUT_PER_MTOK: 'cheap', KMS_JEV_PRICE_OUTPUT_PER_MTOK: '-1' })).toEqual({ inputPerMtok: 0.042, outputPerMtok: 0 })
  })
})

describe('credential routing', () => {
  it('returns null — not a throw — when there is no route to Jev', () => {
    expect(createJevDecisionEngineFromEnv({})).toBeNull()
    expect(createJevDecisionEngineFromEnv({ TYPESAFE_API_KEY: '   ' })).toBeNull()
  })

  it('needs BOTH the OneCLI token and the gateway URL — it will not guess where to send a token', () => {
    expect(createOneCliFetch({ ONECLI_TOKEN: 't' })).toBeNull()
    expect(createOneCliFetch({ ONECLI_GATEWAY: 'http://localhost:10255' })).toBeNull()
    expect(createJevDecisionEngineFromEnv({ ONECLI_TOKEN: 't' })).toBeNull()
  })

  it('builds an engine for the gateway route and for a direct key', () => {
    const viaGateway = createJevDecisionEngineFromEnv({
      ONECLI_TOKEN: 'agent-token', ONECLI_GATEWAY: 'http://localhost:10255',
      ONECLI_CA_CERT: '/nonexistent/ca.pem', KMS_JEV_MODEL: 'jev-1.13.0',
    })
    expect(viaGateway).toBeInstanceOf(JevDecisionEngine)
    expect(viaGateway!.requestedModel).toBe('jev-1.13.0')

    const direct = createJevDecisionEngineFromEnv({ TYPESAFE_API_KEY: 'k' })
    expect(direct).toBeInstanceOf(JevDecisionEngine)
    expect(direct!.requestedModel).toBe(JEV_DEFAULT_MODEL)
  })
})

describe('JsonlDecisionLog', () => {
  it('appends one JSON line per run, creating the directory, readable only by the owner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-decision-log-'))
    const file = path.join(dir, 'nested', 'recall-shadow.jsonl')
    try {
      const log = new JsonlDecisionLog(file)
      await log.write({ kind: 'recall_shadow_run', run_id: 'a' } as any)
      await log.write({ kind: 'recall_shadow_run', run_id: 'b' } as any)

      const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
      expect(lines.map(l => JSON.parse(l).run_id)).toEqual(['a', 'b'])
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
