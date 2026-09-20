/**
 * Process-wide cap on in-flight DecisionEngine requests.
 *
 * One pool for every shadow path, not one per experiment and not one per call: TypeSafe's
 * own RAG cookbook runs four at a time against the public endpoint's rate limit, and every
 * path here goes through the same credential gateway. A per-caller cap would let N
 * concurrent searches plus M concurrent writes put 4×(N+M) requests on it at once.
 */
export const JEV_ENGINE_CONCURRENCY = 4

let inFlight = 0
const waiting: Array<() => void> = []

/** Run `fn` once one of the process-wide slots is free. FIFO. */
export async function withEngineSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= JEV_ENGINE_CONCURRENCY) {
    // The releasing call hands its slot over directly, so `inFlight` is not touched here.
    await new Promise<void>(resolve => waiting.push(resolve))
  } else {
    inFlight++
  }
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else inFlight--
  }
}
