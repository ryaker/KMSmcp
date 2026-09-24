/**
 * Process-wide rate limit on DecisionEngine requests: a token bucket.
 *
 * The limit that matters is TypeSafe's documented one, not a concurrency count. The Models
 * page (https://docs.typesafe.ai/models.md) gives jev-1.13.0 **1,200 requests/min and
 * 250k tokens/s**. Our states are a few hundred tokens, so the request rate binds first.
 *
 * This replaces a concurrency-4 FIFO whose comment claimed TypeSafe's RAG cookbook "runs
 * four at a time against the public endpoint's rate limit". That was wrong: `max_workers=4`
 * is that notebook's thread count, the re-rank cookbook uses 12, and neither is a rate
 * limit. The cap was also the whole of the latency the promote checklist reported:
 * measured uncapped, a 20-candidate search took p50 205 ms / p95 356 ms instead of
 * p50 1.6 s / p95 6.3 s at four slots.
 *
 * Defaults:
 *  - 15 requests/second (900/min), 75% of the documented limit. The headroom is for the
 *    SDK's own 429/529 retries, which spend requests this bucket never sees.
 *  - Burst of 20, so one default-size search (topK 20, one request per candidate) goes out
 *    at once. Worst case in any minute is 20 + 15 × 60 = 920 requests, still under 1,200.
 *  - At most 100 callers queued (about 6.7 s of backlog at 15 rps). Past that a request
 *    is refused immediately with `EngineQueueFullError`; waiting longer than any caller's
 *    budget only turns a clear "overloaded" into a late timeout.
 *
 * One bucket for every path (recall shadow, write-dedup shadow): they share one
 * credential and one limit, so a per-caller bucket would let N callers spend N× the rate.
 *
 * `KMS_JEV_RPS` overrides the rate (read once, at first use). Values above the
 * documented 20/s are clamped to it.
 */

import { logger } from '../logger.js'

export const JEV_RPS_ENV = 'KMS_JEV_RPS'
/** Documented jev-1.13.0 limit: 1,200 requests/min. */
export const JEV_DOCUMENTED_RPS_LIMIT = 20
export const JEV_DEFAULT_RPS = 15
/** One default-size recall search (`JEV_SHADOW_TOPK_DEFAULT`) in a single burst. */
export const JEV_DEFAULT_BURST = 20
export const JEV_ENGINE_QUEUE_MAX = 100

/** The bucket's queue is full. Callers record it like any other engine fault. */
export class EngineQueueFullError extends Error {
  constructor(maxQueue: number) {
    super(`decision engine queue full (${maxQueue} waiting); request refused`)
    this.name = 'EngineQueueFullError'
  }
}

/** A queued request was abandoned by its caller (its signal fired) before a token came. */
export class EngineSlotAbortedError extends Error {
  constructor(reason?: unknown) {
    super(`decision engine request abandoned while queued${reason instanceof Error ? `: ${reason.message}` : ''}`)
    this.name = 'EngineSlotAbortedError'
  }
}

export interface TokenBucketOptions {
  /** Tokens added per second. */
  ratePerSecond: number
  /** Bucket capacity; the bucket starts full. */
  burst: number
  /** Most callers allowed to wait at once. */
  maxQueue: number
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number
}

interface Waiter {
  resolve: () => void
  reject: (e: Error) => void
  detach: () => void
}

export class TokenBucket {
  readonly ratePerSecond: number
  readonly burst: number
  readonly maxQueue: number
  private readonly now: () => number
  private tokens: number
  private lastRefill: number
  private readonly queue: Waiter[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: TokenBucketOptions) {
    if (!(options.ratePerSecond > 0)) throw new Error('token bucket rate must be > 0')
    if (!(options.burst >= 1)) throw new Error('token bucket burst must be >= 1')
    if (!(options.maxQueue >= 0)) throw new Error('token bucket maxQueue must be >= 0')
    this.ratePerSecond = options.ratePerSecond
    this.burst = options.burst
    this.maxQueue = options.maxQueue
    this.now = options.now ?? (() => Date.now())
    this.tokens = options.burst
    this.lastRefill = this.now()
  }

  /** Callers currently waiting for a token. */
  get queued(): number {
    return this.queue.length
  }

  /**
   * Resolve when a token has been taken for this caller. FIFO: a caller never overtakes
   * one already queued. Rejects with `EngineQueueFullError` at once when the queue is
   * full, and with `EngineSlotAbortedError` if `signal` fires first (the token is not spent).
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new EngineSlotAbortedError(signal.reason))
    this.refill()
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return Promise.resolve()
    }
    if (this.queue.length >= this.maxQueue) return Promise.reject(new EngineQueueFullError(this.maxQueue))

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const at = this.queue.indexOf(waiter)
        if (at >= 0) this.queue.splice(at, 1)
        if (this.queue.length === 0) this.clearTimer()
        reject(new EngineSlotAbortedError(signal?.reason))
      }
      const waiter: Waiter = {
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
      this.schedule()
    })
  }

  private refill(): void {
    const t = this.now()
    const elapsed = Math.max(0, t - this.lastRefill)
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerSecond) / 1000)
    this.lastRefill = t
  }

  private drain(): void {
    this.timer = null
    this.refill()
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1
      const waiter = this.queue.shift()!
      waiter.detach()
      waiter.resolve()
    }
    if (this.queue.length > 0) this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) * 1000) / this.ratePerSecond))
    this.timer = setTimeout(() => this.drain(), waitMs)
    // Never keep the daemon (or a test runner) alive just to hand out a token.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** `KMS_JEV_RPS` as a rate, clamped to the documented limit; the default when unset or invalid. */
export function jevRpsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[JEV_RPS_ENV]
  if (raw === undefined || raw.trim() === '') return JEV_DEFAULT_RPS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(`decision: ignoring ${JEV_RPS_ENV}="${raw}" (not a positive number); using ${JEV_DEFAULT_RPS}`)
    return JEV_DEFAULT_RPS
  }
  if (parsed > JEV_DOCUMENTED_RPS_LIMIT) {
    logger.warn(`decision: ${JEV_RPS_ENV}=${parsed} exceeds the documented ${JEV_DOCUMENTED_RPS_LIMIT}/s (1,200/min); clamping`)
    return JEV_DOCUMENTED_RPS_LIMIT
  }
  return parsed
}

let shared: TokenBucket | null = null

/** The process-wide bucket, built from the environment on first use. */
export function engineRateLimiter(): TokenBucket {
  if (!shared) {
    shared = new TokenBucket({ ratePerSecond: jevRpsFromEnv(), burst: JEV_DEFAULT_BURST, maxQueue: JEV_ENGINE_QUEUE_MAX })
  }
  return shared
}

/** Replace (or, with no argument, reset to lazy-from-env) the process-wide bucket. For tests. */
export function setEngineRateLimiterForTests(bucket?: TokenBucket): void {
  shared = bucket ?? null
}

export interface EngineSlotOptions {
  /** Abandon the wait (not a started request) when this fires. */
  signal?: AbortSignal
}

/**
 * Run `fn` once the process-wide bucket grants a token. The name is kept from the old
 * concurrency slot so callers did not change; there is no longer a cap on requests in
 * flight, only on the rate at which they start.
 */
export async function withEngineSlot<T>(fn: () => Promise<T>, options: EngineSlotOptions = {}): Promise<T> {
  await engineRateLimiter().acquire(options.signal)
  return fn()
}
