/**
 * Unit tests for OllamaEmbeddingService.
 *
 * Mocks global.fetch so the tests run without a live Ollama. Verifies:
 *   - 768-dim Float32Array shape
 *   - embedderId surfacing (model:version)
 *   - graceful failure: timeout, non-200, malformed body, dim mismatch
 *   - retry-once on AbortError / network error
 *   - isAvailable: caches result, treats /api/tags as the probe
 */

import { OllamaEmbeddingService } from '../embedding/EmbeddingService.js'

// Build a fake nomic-style response: { embedding: number[768] }
function fakeEmbedding(dim = 768): number[] {
  const out = new Array(dim)
  for (let i = 0; i < dim; i++) out[i] = Math.sin(i)
  return out
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    json: async () => body,
  } as unknown as Response
}

describe('OllamaEmbeddingService', () => {
  const originalFetch = global.fetch
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // embed() — happy path
  // -------------------------------------------------------------------------

  it('returns a Float32Array of 768 dimensions', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: fakeEmbedding(768) }))

    const svc = new OllamaEmbeddingService()
    const vec = await svc.embed('hello world')

    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(768)
    // Spot check: sin(0)=0, sin(1)≈0.841
    expect(vec[0]).toBeCloseTo(0, 5)
    expect(vec[1]).toBeCloseTo(Math.sin(1), 5)
  })

  it('exposes embedderId in model:version format', () => {
    const svc = new OllamaEmbeddingService()
    expect(svc.embedderId).toBe('nomic-embed-text:v1')
  })

  it('embedderId reflects custom model + version', () => {
    const svc = new OllamaEmbeddingService({ model: 'mxbai-embed-large', version: 'v2' })
    expect(svc.embedderId).toBe('mxbai-embed-large:v2')
  })

  it('honours OLLAMA_BASE_URL env var', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: fakeEmbedding(768) }))
    const prev = process.env.OLLAMA_BASE_URL
    process.env.OLLAMA_BASE_URL = 'http://example.test:9999'
    try {
      const svc = new OllamaEmbeddingService()
      await svc.embed('x')
      const url = fetchMock.mock.calls[0][0]
      expect(String(url)).toBe('http://example.test:9999/api/embeddings')
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = prev
    }
  })

  it('explicit baseUrl beats env var', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: fakeEmbedding(768) }))
    const prevEnv = process.env.OLLAMA_BASE_URL
    process.env.OLLAMA_BASE_URL = 'http://env.test:1111'
    try {
      const svc = new OllamaEmbeddingService({ baseUrl: 'http://explicit.test:2222' })
      await svc.embed('x')
      const url = fetchMock.mock.calls[0][0]
      expect(String(url)).toBe('http://explicit.test:2222/api/embeddings')
    } finally {
      if (prevEnv === undefined) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = prevEnv
    }
  })

  it('sends model + prompt in the request body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: fakeEmbedding(768) }))
    const svc = new OllamaEmbeddingService()
    await svc.embed('the quick brown fox')

    const init = fetchMock.mock.calls[0][1]
    const body = JSON.parse(init.body)
    expect(body).toEqual({ model: 'nomic-embed-text', prompt: 'the quick brown fox' })
  })

  // -------------------------------------------------------------------------
  // embed() — failure paths
  // -------------------------------------------------------------------------

  it('throws on dim mismatch (defends against model swap)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: fakeEmbedding(384) }))  // wrong dim
    const svc = new OllamaEmbeddingService()
    await expect(svc.embed('x')).rejects.toThrow(/dim mismatch/i)
  })

  it('throws on missing embedding field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ wrong_key: [1, 2, 3] }))
    const svc = new OllamaEmbeddingService()
    await expect(svc.embed('x')).rejects.toThrow(/missing or non-array/i)
  })

  it('throws on non-numeric value in embedding', async () => {
    const bad = fakeEmbedding(768)
    bad[5] = 'not-a-number' as any
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: bad }))
    const svc = new OllamaEmbeddingService()
    await expect(svc.embed('x')).rejects.toThrow(/non-finite/i)
  })

  it('throws on non-200 HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'down' }, false, 500))
    const svc = new OllamaEmbeddingService()
    await expect(svc.embed('x')).rejects.toThrow(/HTTP 500/)
  })

  it('throws TypeError on empty input (defensive)', async () => {
    const svc = new OllamaEmbeddingService()
    await expect(svc.embed('')).rejects.toThrow(TypeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries once on transient network error then succeeds', async () => {
    const networkErr = new Error('fetch failed')
    fetchMock.mockRejectedValueOnce(networkErr)
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: fakeEmbedding(768) }))

    const svc = new OllamaEmbeddingService()
    const vec = await svc.embed('x')
    expect(vec.length).toBe(768)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry on dimension mismatch (deterministic failure)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ embedding: fakeEmbedding(384) }))
    const svc = new OllamaEmbeddingService()
    await expect(svc.embed('x')).rejects.toThrow(/dim mismatch/i)
    // Only the first call — no retry, since dim mismatch means model swap
    // not a transient blip.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after retry on persistent network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const svc = new OllamaEmbeddingService()
    await expect(svc.embed('x')).rejects.toThrow(/ECONNREFUSED/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // isAvailable()
  // -------------------------------------------------------------------------

  it('isAvailable: true when /api/tags returns 200', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true } as unknown as Response)
    const svc = new OllamaEmbeddingService()
    expect(await svc.isAvailable()).toBe(true)
    const url = fetchMock.mock.calls[0][0]
    expect(String(url)).toMatch(/\/api\/tags$/)
  })

  it('isAvailable: false when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'))
    const svc = new OllamaEmbeddingService()
    expect(await svc.isAvailable()).toBe(false)
  })

  it('isAvailable: caches the result for ~30s', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true } as unknown as Response)
    const svc = new OllamaEmbeddingService()
    await svc.isAvailable()
    await svc.isAvailable()
    await svc.isAvailable()
    // Single underlying call — cache hits avoid extra HTTP traffic.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('isAvailable: probe budget is well above LAN round-trip, not the old 500ms', async () => {
    // Regression guard. The probe was hardcoded to 500 ms, which is 10x stricter than
    // DEFAULT_TIMEOUT_MS and fails against an Ollama on another host. We assert the
    // AbortSignal handed to fetch has not already fired after a LAN-typical delay.
    let captured: AbortSignal | undefined
    fetchMock.mockImplementationOnce(async (_url: unknown, init: unknown) => {
      captured = (init as { signal?: AbortSignal } | undefined)?.signal
      await new Promise(r => setTimeout(r, 600))
      return { ok: true } as unknown as Response
    })
    const svc = new OllamaEmbeddingService()
    expect(await svc.isAvailable()).toBe(true)
    expect(captured?.aborted).toBe(false)
  })

  it('isAvailable: a failure expires fast so one slow probe does not disable embedding', async () => {
    // Previously a negative result was cached for the full 30 s, meaning a single
    // transient blip suppressed embedding for every write in the next half-minute.
    fetchMock.mockRejectedValueOnce(new Error('connection refused'))
    const svc = new OllamaEmbeddingService()
    expect(await svc.isAvailable()).toBe(false)

    // Advance past the short failure TTL (5 s) but well inside the 30 s success TTL.
    const realNow = Date.now
    Date.now = () => realNow() + 6_000
    try {
      fetchMock.mockResolvedValueOnce({ ok: true } as unknown as Response)
      expect(await svc.isAvailable()).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      Date.now = realNow
    }
  })
})
