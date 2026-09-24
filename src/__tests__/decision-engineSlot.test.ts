/**
 * The process-wide engine rate limit: a token bucket sized from TypeSafe's documented
 * jev-1.13.0 limit (1,200 requests/min). Fake timers only; no real sleeps.
 */

import {
  EngineQueueFullError,
  EngineSlotAbortedError,
  JEV_DEFAULT_BURST,
  JEV_DEFAULT_RPS,
  JEV_DOCUMENTED_RPS_LIMIT,
  JEV_ENGINE_QUEUE_MAX,
  TokenBucket,
  engineRateLimiter,
  jevRpsFromEnv,
  setEngineRateLimiterForTests,
  withEngineSlot,
} from '../decision/engineSlot.js'

beforeEach(() => jest.useFakeTimers())
afterEach(() => {
  jest.useRealTimers()
  setEngineRateLimiterForTests()
})

/** Fire `n` acquires and count how many have been granted so far. */
function acquireMany(bucket: TokenBucket, n: number, signal?: AbortSignal) {
  const granted: number[] = []
  const rejected: Array<{ index: number; error: unknown }> = []
  const all = Array.from({ length: n }, (_, i) =>
    bucket.acquire(signal).then(() => { granted.push(i) }, error => { rejected.push({ index: i, error }) }))
  return { granted, rejected, all: Promise.all(all) }
}

describe('TokenBucket', () => {
  it('grants a full burst at once, then no faster than the rate', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 15, burst: 20, maxQueue: 100 })
    const { granted, all } = acquireMany(bucket, 50)

    await jest.advanceTimersByTimeAsync(0)
    expect(granted).toHaveLength(20)

    // 15 more per second: none early, none late (timer granularity is 1 ms).
    await jest.advanceTimersByTimeAsync(990)
    expect(granted).toHaveLength(34)
    await jest.advanceTimersByTimeAsync(20)
    expect(granted).toHaveLength(35)

    await jest.advanceTimersByTimeAsync(1000)
    expect(granted).toHaveLength(50)
    await all
    // FIFO: nobody overtakes an earlier caller.
    expect(granted).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })

  it('never exceeds rate × time + burst over a sustained minute', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 15, burst: 20, maxQueue: 5000 })
    const { granted } = acquireMany(bucket, 2000)
    await jest.advanceTimersByTimeAsync(60_000)
    expect(granted.length).toBeLessThanOrEqual(20 + 15 * 60)
    expect(granted.length).toBeGreaterThanOrEqual(15 * 60)
    // Under the documented 1,200 requests/min.
    expect(granted.length).toBeLessThan(1200)
  })

  it('refills while idle, up to the burst and no further', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 5, maxQueue: 100 })
    await acquireMany(bucket, 5).all
    await jest.advanceTimersByTimeAsync(60_000)

    const { granted } = acquireMany(bucket, 10)
    await jest.advanceTimersByTimeAsync(0)
    expect(granted).toHaveLength(5)
  })

  it('refuses at once with EngineQueueFullError when the queue is full', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 2, maxQueue: 3 })
    const { granted, rejected } = acquireMany(bucket, 7)
    await jest.advanceTimersByTimeAsync(0)

    expect(granted).toHaveLength(2)
    expect(bucket.queued).toBe(3)
    expect(rejected.map(r => r.index)).toEqual([5, 6])
    for (const { error } of rejected) {
      expect(error).toBeInstanceOf(EngineQueueFullError)
      expect((error as Error).name).toBe('EngineQueueFullError')
    }
  })

  it('drops a waiter whose signal fires, without spending its token', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 1, maxQueue: 10 })
    await bucket.acquire()

    const controller = new AbortController()
    const abandoned = bucket.acquire(controller.signal)
    const next = bucket.acquire()
    expect(bucket.queued).toBe(2)

    controller.abort()
    await expect(abandoned).rejects.toBeInstanceOf(EngineSlotAbortedError)
    expect(bucket.queued).toBe(1)

    // The abandoned caller's token goes to the next one in line, at the rate.
    await jest.advanceTimersByTimeAsync(1000)
    await expect(next).resolves.toBeUndefined()
  })

  it('rejects an already-aborted signal without queueing', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 1, maxQueue: 10 })
    const controller = new AbortController()
    controller.abort()
    await expect(bucket.acquire(controller.signal)).rejects.toBeInstanceOf(EngineSlotAbortedError)
    expect(bucket.queued).toBe(0)
    await expect(bucket.acquire()).resolves.toBeUndefined() // the token was not spent
  })

  it('rejects nonsense configuration', () => {
    expect(() => new TokenBucket({ ratePerSecond: 0, burst: 1, maxQueue: 1 })).toThrow()
    expect(() => new TokenBucket({ ratePerSecond: 1, burst: 0, maxQueue: 1 })).toThrow()
  })
})

describe('KMS_JEV_RPS', () => {
  it('defaults to 15/s with a burst that fits one 20-candidate search', () => {
    expect(JEV_DEFAULT_RPS).toBe(15)
    expect(JEV_DEFAULT_BURST).toBe(20)
    expect(jevRpsFromEnv({})).toBe(15)
    const shared = engineRateLimiter()
    expect(shared.ratePerSecond).toBe(15)
    expect(shared.burst).toBe(20)
    expect(shared.maxQueue).toBe(JEV_ENGINE_QUEUE_MAX)
  })

  it('accepts a positive override, clamps above the documented limit, ignores junk', () => {
    expect(jevRpsFromEnv({ KMS_JEV_RPS: '5' })).toBe(5)
    expect(jevRpsFromEnv({ KMS_JEV_RPS: '2.5' })).toBe(2.5)
    expect(jevRpsFromEnv({ KMS_JEV_RPS: '100' })).toBe(JEV_DOCUMENTED_RPS_LIMIT)
    for (const bad of ['0', '-3', 'fast', ' ']) expect(jevRpsFromEnv({ KMS_JEV_RPS: bad })).toBe(JEV_DEFAULT_RPS)
  })
})

describe('withEngineSlot', () => {
  it('runs the call once the shared bucket grants a token', async () => {
    setEngineRateLimiterForTests(new TokenBucket({ ratePerSecond: 1, burst: 1, maxQueue: 10 }))
    const fn = jest.fn(async () => 'ok')

    await expect(withEngineSlot(fn)).resolves.toBe('ok')
    const second = withEngineSlot(fn)
    await jest.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1000)
    await expect(second).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('rejects without calling fn when the queue is full', async () => {
    setEngineRateLimiterForTests(new TokenBucket({ ratePerSecond: 1, burst: 1, maxQueue: 0 }))
    const fn = jest.fn(async () => 'ok')
    await withEngineSlot(fn)
    await expect(withEngineSlot(fn)).rejects.toBeInstanceOf(EngineQueueFullError)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
