/**
 * Classification of failures from the vector-index write path.
 *
 * Extracted into its own module for two reasons. It is the kind of logic that
 * must not regress silently, and `SparrowDBStorage.ts` uses `import.meta.url`,
 * which Jest's CommonJS transform cannot load — so nothing in that file has ever
 * been unit-testable. Keeping this pure and dependency-free makes it so.
 *
 * WHY IT EXISTS AT ALL. `storeEmbedding` used to catch every exception, log it at
 * debug, and attribute it to "likely sidecar-orphan". Reasonable when the only
 * realistic failure was a missing graph node.
 *
 * SparrowDB #442 invalidated that. A stale handle's vector write is now REFUSED
 * with "HNSW index generation conflict", and because `load_vector_indexes` runs
 * only inside `GraphDb::open()` with no in-process refresh, the refusal is
 * permanent until the process restarts. Our daemon is long-lived under launchd,
 * so the first time any other process writes the index, every subsequent
 * embedding write fails forever — and the old handler made that invisible.
 *
 * #442 exists to turn silent data loss into a loud, catchable refusal. Swallowing
 * it one layer up is worse than the bug it replaced: silent TOTAL write stoppage
 * rather than silent partial loss.
 */

export type EmbeddingWriteFailure =
  /** Stale handle — the index was written by another process. Permanent until restart. */
  | 'lost-update'
  /** No graph node for this id. Expected for pre-cutover sidecar orphans. */
  | 'sidecar-orphan'
  /** Unrecognised. Treated as suspicious on purpose. */
  | 'unclassified'

/**
 * Classify a vector-index write failure by its message.
 *
 * Defaults to `unclassified` rather than to the benign case. An unknown failure
 * mode being invisible is precisely how the generation-conflict problem would
 * have survived unnoticed.
 */
export function classifyEmbeddingWriteError(message: string): EmbeddingWriteFailure {
  // Two distinct texts, one meaning. "generation conflict" is #442's own refusal.
  // The ENOENT variant is the same lost update wearing different clothes: #442's
  // temp path is a deterministic `<path>.tmp` with no pid, so two concurrent
  // writers collide and the loser's rename fails with "No such file or
  // directory". Notably that one does NOT match SparrowDB's own is_lost_update()
  // helper, which string-matches the generation-conflict prefix — so a caller
  // relying on the upstream helper alone would misread it as a disk fault.
  if (/generation conflict|no such file or directory|os error 2/i.test(message)) {
    return 'lost-update'
  }

  // ~185 sidecar entries exist in the JSON sidecar but never got a graph node
  // (pre-cutover legacy), so the MATCH finds nothing. High volume and expected;
  // promoting these would bury the failures that matter.
  if (/not found|no node|0 rows|does not exist/i.test(message)) {
    return 'sidecar-orphan'
  }

  return 'unclassified'
}

/** Operator-facing text for a lost-update refusal. Must state that it is permanent. */
export function lostUpdateMessage(id: string, detail: string): string {
  return (
    `storeEmbedding: VECTOR INDEX WRITES ARE FAILING for ${id}: ${detail}\n` +
    `  This process's HNSW handle is stale — another process wrote the index.\n` +
    `  The refusal is PERMANENT for this process: SparrowDB loads the index only\n` +
    `  at open() and exposes no refresh. Every further embedding write will fail\n` +
    `  until this daemon is restarted. Embeddings are NOT being indexed; semantic\n` +
    `  dedup and vector retrieval are degraded until then.`
  )
}
