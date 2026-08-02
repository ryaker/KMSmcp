/**
 * Pins the vector-index health probe.
 *
 * The case that matters most is MISSING. SparrowDB #451: a damaged index is
 * quarantined on the first open(), after which the file is absent, the next
 * open() succeeds, and the store looks perfectly healthy while silently
 * discarding every embedding write. Our daemon restarts on any rebuild of dist/,
 * so it would pass through that sequence unattended.
 *
 * A probe that returns "ok" or "unknown" in that state is worse than no probe,
 * because it launders silence into reassurance.
 */

import {
  probeVectorIndex,
  UNREACHABLE_ALERT_FRACTION,
  type VectorIndexProbeTarget,
} from '../storage/vectorIndexHealth.js'

const withHealth = (stored: number, reachable: number): VectorIndexProbeTarget => ({
  vectorIndexHealth: () => ({ stored, reachable, unreachable: stored - reachable }),
})

describe('probeVectorIndex — precise path (vectorIndexHealth available)', () => {
  it('reports ok on a healthy index', () => {
    const r = probeVectorIndex(withHealth(2494, 2494), 'Knowledge', 'embedding')
    expect(r.status).toBe('ok')
    expect(r.precise).toBe(true)
    expect(r.alert).toBeUndefined()
  })

  it('tolerates a small unreachable set instead of crying wolf', () => {
    // Our live store sat at 56/2494 (2.2%) while functioning, and SparrowDB #448
    // is still open. Alerting at zero would get muted, which is worse than silence.
    const r = probeVectorIndex(withHealth(2494, 2438), 'Knowledge', 'embedding')
    expect(r.status).toBe('ok')
    expect(r.unreachable).toBe(56)
  })

  it('reports degraded once unreachable passes the threshold', () => {
    const stored = 1000
    const unreachable = Math.ceil(stored * UNREACHABLE_ALERT_FRACTION) + 1
    const r = probeVectorIndex(withHealth(stored, stored - unreachable), 'Knowledge', 'embedding')
    expect(r.status).toBe('degraded')
    expect(r.alert).toMatch(/DEGRADED/)
    // The alert has to say what to do, and the constraint that makes it fail.
    expect(r.alert).toMatch(/repairVectorIndex/)
    expect(r.alert).toMatch(/sole writer/)
  })

  it('treats stored=0 as MISSING, not as an empty-but-healthy index', () => {
    const r = probeVectorIndex(withHealth(0, 0), 'Knowledge', 'embedding')
    expect(r.status).toBe('missing')
    expect(r.alert).toMatch(/IS MISSING/)
    expect(r.alert).toMatch(/#451/)
  })

  it('maps SparrowDB\'s "no vector index" throw to MISSING', () => {
    const db: VectorIndexProbeTarget = {
      vectorIndexHealth: () => { throw new Error('no vector index on (Knowledge, embedding); call createVectorIndex first') },
    }
    const r = probeVectorIndex(db, 'Knowledge', 'embedding')
    expect(r.status).toBe('missing')
    expect(r.alert).toMatch(/silently dropped/)
  })

  it('reports unknown — never ok — when the probe itself fails', () => {
    const db: VectorIndexProbeTarget = {
      vectorIndexHealth: () => { throw new Error('lock poisoned') },
    }
    expect(probeVectorIndex(db, 'Knowledge', 'embedding').status).toBe('unknown')
  })
})

describe('probeVectorIndex — fallback path (old binding, no vectorIndexHealth)', () => {
  // The binding we run today predates vectorIndexHealth, and we are deliberately
  // not upgrading yet. The fallback must still catch the missing-index case.
  it('derives reachability from vectorSearch and marks itself imprecise', () => {
    const db: VectorIndexProbeTarget = { vectorSearch: () => new Array(2438).fill(0) }
    const r = probeVectorIndex(db, 'Knowledge', 'embedding')
    expect(r.status).toBe('ok')
    expect(r.reachable).toBe(2438)
    expect(r.precise).toBe(false)
    expect(r.stored).toBeNull()      // cannot know; must not guess
    expect(r.unreachable).toBeNull()
  })

  it('still catches MISSING when search returns nothing', () => {
    const db: VectorIndexProbeTarget = { vectorSearch: () => [] }
    expect(probeVectorIndex(db, 'Knowledge', 'embedding').status).toBe('missing')
  })

  it('still catches MISSING when search throws "no vector index"', () => {
    const db: VectorIndexProbeTarget = {
      vectorSearch: () => { throw new Error('no vector index on (Knowledge, embedding)') },
    }
    expect(probeVectorIndex(db, 'Knowledge', 'embedding').status).toBe('missing')
  })
})

describe('probeVectorIndex — never throws, never launders silence into health', () => {
  it('handles a null handle', () => {
    expect(probeVectorIndex(null, 'Knowledge', 'embedding').status).toBe('unknown')
  })

  it('handles a binding exposing neither method', () => {
    const r = probeVectorIndex({}, 'Knowledge', 'embedding')
    expect(r.status).toBe('unknown')
    expect(r.alert).toMatch(/neither vectorIndexHealth nor vectorSearch/)
  })

  it('never reports ok without evidence', () => {
    // The whole point: an unusable probe must not look like a passing one.
    for (const db of [null, undefined, {} as VectorIndexProbeTarget]) {
      expect(probeVectorIndex(db, 'Knowledge', 'embedding').status).not.toBe('ok')
    }
  })
})
