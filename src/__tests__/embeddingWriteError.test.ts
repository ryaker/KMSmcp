/**
 * Pins the failure classification for vector-index writes.
 *
 * The behaviour under test is not cosmetic. Before this existed, storeEmbedding
 * logged every exception at debug and blamed "likely sidecar-orphan". After
 * SparrowDB #442, a stale handle's write is refused permanently until the process
 * restarts — so that handler would have hidden a total, ongoing write stoppage
 * behind a debug line attributing it to the wrong cause.
 */

import { classifyEmbeddingWriteError, lostUpdateMessage } from '../storage/embeddingWriteError.js'

describe('classifyEmbeddingWriteError', () => {
  it('classifies #442\'s generation-conflict refusal as a lost update', () => {
    expect(classifyEmbeddingWriteError(
      'HNSW save failed: HNSW index generation conflict: on-disk 7, handle 6',
    )).toBe('lost-update')
  })

  it('classifies the ENOENT temp-collision variant as the SAME lost update', () => {
    // #442's temp path is a deterministic `<path>.tmp` with no pid, so two
    // concurrent writers collide and the loser's rename fails with ENOENT.
    // Same data loss, different text — and it does NOT match SparrowDB's own
    // is_lost_update(), which only matches the generation-conflict prefix.
    expect(classifyEmbeddingWriteError(
      'HNSW save failed: No such file or directory (os error 2)',
    )).toBe('lost-update')
  })

  it('keeps the benign missing-node case separate', () => {
    for (const m of ['node not found for id x', 'no node with id=abc', '0 rows matched']) {
      expect(classifyEmbeddingWriteError(m)).toBe('sidecar-orphan')
    }
  })

  it('defaults to unclassified rather than to benign', () => {
    // The whole point: an unrecognised failure must not inherit the quiet path.
    expect(classifyEmbeddingWriteError('some entirely novel engine failure')).toBe('unclassified')
    expect(classifyEmbeddingWriteError('')).toBe('unclassified')
  })

  it('does not mistake an unrelated message merely containing "conflict"', () => {
    expect(classifyEmbeddingWriteError('merge conflict in user data')).toBe('unclassified')
  })
})

describe('lostUpdateMessage', () => {
  it('states that the failure is permanent and names the remedy', () => {
    // An operator reading one line must learn that embeddings are not being
    // indexed and that only a restart clears it. Anything vaguer gets ignored.
    const text = lostUpdateMessage('entry-1', 'HNSW index generation conflict')
    expect(text).toMatch(/PERMANENT/)
    expect(text).toMatch(/restart/i)
    expect(text).toMatch(/NOT being\s+indexed/)
    expect(text).toContain('entry-1')
  })
})
