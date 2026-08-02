/**
 * Vector-index health probe.
 *
 * WHY THIS EXISTS. On 2026-08-01 KMS lost ~1150 embedding vectors and nobody
 * noticed until a retrieval investigation went looking. Nothing in this codebase
 * has ever measured whether the HNSW index is actually usable — the one repair we
 * ran (56 unreachable -> 0) was a manual one-off, so any regression accumulates
 * silently and indefinitely.
 *
 * It became urgent with SparrowDB #451, a residual hole that survives all four of
 * their merged fixes:
 *
 *   1. index becomes damaged
 *   2. FIRST open() -> loud Err(Corruption), bytes quarantined to .corrupt.<millis>
 *   3. SECOND open() -> the .bin no longer exists, so this is now the ABSENT case.
 *      open() SUCCEEDS with no index registered.
 *   4. every vector write is silently dropped, every search returns nothing
 *
 * Our daemon runs under launchd with KeepAlive=true and `node --watch dist/index.js`,
 * so it restarts on any rebuild. It would hit step 2 once, log a crash, relaunch,
 * and sail straight into step 3 — a healthy-looking store quietly discarding every
 * embedding. Same loss as the original incident, reached by a different route.
 *
 * SparrowDB's own guidance: until #451 lands, a periodic health check is the only
 * thing standing between a quarantine event and unbounded silent loss. Step 3 is
 * the dangerous one precisely because the store looks perfectly healthy by every
 * other measure — which is why MISSING is treated as critical here, not as "no
 * data". An absent index is indistinguishable from a healthy one unless you are
 * specifically looking for it.
 *
 * DEGRADES BY DESIGN. `vectorIndexHealth()` only exists in SparrowDB >= 1d5cec1,
 * and we are deliberately NOT on that build yet (four unfixed criticals live on
 * their main). So this feature-detects and falls back to a reachability count
 * derived from vectorSearch, which works on the binding we run today. The
 * fallback cannot see `stored`, so it cannot compute unreachable — but it CAN
 * still detect the missing-index case, which is the one that matters most.
 */

/** What the probe could determine. Ordered by severity, worst first. */
export type VectorIndexStatus =
  /** No index registered for (label, prop). SparrowDB #451 step 3 — writes are being dropped. */
  | 'missing'
  /** Index present, but a meaningful share of stored vectors are unreachable. */
  | 'degraded'
  /** Index present and healthy. */
  | 'ok'
  /** Binding too old, or the probe itself failed. Absence of evidence, not evidence of health. */
  | 'unknown'

export interface VectorIndexHealthReport {
  status: VectorIndexStatus
  /** Vectors the index holds. Null when only the fallback probe was available. */
  stored: number | null
  /** Vectors greedy search can actually reach. */
  reachable: number | null
  /** stored - reachable. Null unless the full accessor was available. */
  unreachable: number | null
  /** True when the numbers came from vectorIndexHealth() rather than the fallback. */
  precise: boolean
  /** Present when status is not 'ok'. Written for a human reading one line at 3am. */
  alert?: string
}

/** Minimal surface this probe needs. Everything optional — old bindings lack most of it. */
export interface VectorIndexProbeTarget {
  vectorIndexHealth?(label: string, property: string): { stored: number; reachable: number; unreachable: number }
  vectorSearch?(label: string, property: string, query: Float32Array, k: number): unknown[]
}

/**
 * Fraction of stored vectors allowed to be unreachable before reporting 'degraded'.
 *
 * 0.05 rather than 0. A small unreachable set is a known, tolerated property of
 * this HNSW implementation — SparrowDB #443's reciprocal-link fix reduces it but
 * #448 is still open, and our own store sat at 56/2494 (2.2%) while functioning.
 * Alerting at zero would cry wolf permanently and get muted, which is worse than
 * not alerting at all.
 */
export const UNREACHABLE_ALERT_FRACTION = 0.05

const PROBE_DIMENSIONS = 768
const PROBE_TOP_K = 100_000

/**
 * Probe one (label, property) vector index.
 *
 * Never throws: a monitoring probe that can take down its caller is worse than no
 * probe. Every failure path resolves to a report, and an unusable probe reports
 * 'unknown' rather than 'ok' — silence must never be mistaken for health.
 */
export function probeVectorIndex(
  db: VectorIndexProbeTarget | null | undefined,
  label: string,
  property: string,
): VectorIndexHealthReport {
  if (!db) {
    return { status: 'unknown', stored: null, reachable: null, unreachable: null, precise: false,
      alert: 'vector index probe skipped: no graph handle' }
  }

  // Preferred path — SparrowDB >= 1d5cec1. Verified safe against a live store:
  // it routes through get_vector_index(), a pure RwLock read with zero I/O, so it
  // cannot quarantine or otherwise mutate the index it is measuring.
  if (typeof db.vectorIndexHealth === 'function') {
    try {
      const h = db.vectorIndexHealth(label, property)
      const { stored, reachable } = h
      const unreachable = h.unreachable ?? stored - reachable
      if (stored === 0) {
        return { status: 'missing', stored, reachable, unreachable, precise: true,
          alert: missingAlert(label, property) }
      }
      if (unreachable / stored > UNREACHABLE_ALERT_FRACTION) {
        return { status: 'degraded', stored, reachable, unreachable, precise: true,
          alert:
            `vector index (${label}, ${property}) DEGRADED: ${unreachable} of ${stored} vectors ` +
            `(${((unreachable / stored) * 100).toFixed(1)}%) are stored but unreachable by search. ` +
            `Run repairVectorIndex('${label}','${property}') with the daemon stopped — it must be ` +
            `the sole writer, or SparrowDB's generation check will refuse its save.` }
      }
      return { status: 'ok', stored, reachable, unreachable, precise: true }
    } catch (e) {
      // SparrowDB throws "no vector index on (L, p); call createVectorIndex first"
      // when nothing is registered — which is exactly #451 step 3.
      const msg = e instanceof Error ? e.message : String(e)
      if (/no vector index/i.test(msg)) {
        return { status: 'missing', stored: 0, reachable: 0, unreachable: 0, precise: true,
          alert: missingAlert(label, property) }
      }
      return { status: 'unknown', stored: null, reachable: null, unreachable: null, precise: false,
        alert: `vector index probe failed for (${label}, ${property}): ${msg}` }
    }
  }

  // Fallback for the binding we actually run today. It cannot see `stored`, so it
  // cannot compute unreachable — but it still catches the missing-index case,
  // which is the one that silently eats writes.
  if (typeof db.vectorSearch === 'function') {
    try {
      const hits = db.vectorSearch(label, property, new Float32Array(PROBE_DIMENSIONS).fill(0.01), PROBE_TOP_K)
      const reachable = Array.isArray(hits) ? hits.length : 0
      if (reachable === 0) {
        return { status: 'missing', stored: null, reachable: 0, unreachable: null, precise: false,
          alert: missingAlert(label, property) }
      }
      return { status: 'ok', stored: null, reachable, unreachable: null, precise: false }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/no vector index/i.test(msg)) {
        return { status: 'missing', stored: null, reachable: null, unreachable: null, precise: false,
          alert: missingAlert(label, property) }
      }
      return { status: 'unknown', stored: null, reachable: null, unreachable: null, precise: false,
        alert: `vector index probe failed for (${label}, ${property}): ${msg}` }
    }
  }

  return { status: 'unknown', stored: null, reachable: null, unreachable: null, precise: false,
    alert: 'vector index probe unavailable: binding exposes neither vectorIndexHealth nor vectorSearch' }
}

function missingAlert(label: string, property: string): string {
  return (
    `vector index (${label}, ${property}) IS MISSING — embedding writes are being silently dropped. ` +
    `This is SparrowDB #451: a damaged index is quarantined on the first open(), after which the ` +
    `file is absent, the next open() succeeds, and the store looks healthy while discarding every ` +
    `vector. Check for hnsw_${label}_${property}.bin.corrupt.* artifacts in the store's ` +
    `vector_indexes/ directory, then restore or rebuild the index.`
  )
}
