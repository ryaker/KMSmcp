/**
 * OllamaInference structured output — pins that the router and entity calls
 * send a JSON Schema in `format`, so the output shape is enforced by Ollama
 * rather than requested by prompt wording.
 *
 * Why: gemma4:12b-mlx intermittently wrapped router JSON in ```json fences
 * despite "No markdown", and every fence sent a live write to the regex
 * fallback (seen 2026-09-23). Measured on rym1: format:'json' alone let the
 * model return {"ids":[...]} for the entity call; an array schema returned the
 * bare array every time. No live Ollama — fetch is mocked at the seam.
 */
import { jest } from '@jest/globals'
import { OllamaInference } from '../inference/OllamaInference.js'

function mockFetch(response: string) {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ response }),
  }))
  ;(globalThis as any).fetch = fetchMock
  return fetchMock
}

/** Body of the /api/generate call (entity extraction probes GET /api/tags first). */
function sentBody(fetchMock: jest.Mock): Record<string, any> {
  const call = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/generate'))
  if (!call) throw new Error('no /api/generate call was made')
  return JSON.parse((call[1] as { body: string }).body)
}

describe('OllamaInference structured output', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { (globalThis as any).fetch = realFetch })

  it('classifyStorageTargets sends an object schema pinning targets/contentType/confidence', async () => {
    const fetchMock = mockFetch('{"targets":["graph","mem0"],"contentType":"factual","confidence":0.9}')
    const inf = new OllamaInference('http://ollama.test', 'gemma4:12b-mlx')

    const result = await inf.classifyStorageTargets('Phoenix has 8 cameras.')

    const body = sentBody(fetchMock)
    expect(body.format.type).toBe('object')
    expect(body.format.required).toEqual(['targets', 'contentType', 'confidence'])
    expect(body.format.properties.targets.items.enum).toEqual(['graph', 'mem0', 'mongodb'])
    expect(body.think).toBe(false)
    expect(result).toEqual({ targets: ['graph', 'mem0'], contentType: 'factual', confidence: 0.9 })
  })

  it('extractEntityMentions sends an array schema, not bare "json"', async () => {
    const fetchMock = mockFetch('["p1","p2"]')
    const inf = new OllamaInference('http://ollama.test', 'gemma4:12b-mlx')

    const ids = await inf.extractEntityMentions('Rich asked about Phoenix.', [
      { id: 'p1', name: 'Rich Yaker' },
      { id: 'p2', name: 'Phoenix' },
    ])

    const body = sentBody(fetchMock)
    expect(body.format).toEqual({ type: 'array', items: { type: 'string' } })
    expect(ids).toEqual(['p1', 'p2'])
  })

  it('a fenced reply still degrades to null (regex fallback), never throws', async () => {
    mockFetch('```json\n{"targets":["graph"],"contentType":"factual","confidence":1}\n```')
    const inf = new OllamaInference('http://ollama.test', 'gemma4:12b-mlx')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(inf.classifyStorageTargets('anything')).resolves.toBeNull()
    warn.mockRestore()
  })

  it('generate() omits format unless the caller asks for it (distillers unchanged)', async () => {
    const fetchMock = mockFetch('free text')
    const inf = new OllamaInference('http://ollama.test', 'gemma4:12b-mlx')

    await inf.generate('hello', { numPredict: 8 })

    expect(sentBody(fetchMock)).not.toHaveProperty('format')
  })
})
