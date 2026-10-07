# Embedder comparison: nomic-embed-text vs embeddinggemma-2 (2026-10-06)

**Decision: stay on `nomic-embed-text`.** `embeddinggemma-2:270m` showed no reliable gain on the
large labelled set, is ~2x slower, and would force a full re-embed plus dedup threshold
recalibration. One cheap finding is worth a separate ticket: nomic's own `search_query:` /
`search_document:` prefixes help (below).

## Method
`scripts/eval/embedder-compare.py` re-ranks each query's candidate pool from
`~/.kms/eval/label-pool.jsonl` (the labelling pipeline's output) by cosine similarity and scores
the order against the 0/1/2 relevance grades. Embedding runs on rym1 only. Ranker names:
`nomic_raw` is exactly what production sends (raw text to `/api/embeddings`), `nomic_prefixed`
adds nomic's documented prefixes, `gemma2_raw` is `embeddinggemma-2:270m` on raw text, and
`*256` truncates to 256 dims (Matryoshka) and re-normalises.

Two label sets: 29 queries graded by Gemma (independent of Jev) and 553 graded by Jev.

## Results (nDCG@5, mean; paired difference vs `nomic_raw` with 95% bootstrap CI)
| Ranker | Gemma-labelled, 29 q | Jev-labelled, 553 q | Jev-labelled paired diff |
|---|---|---|---|
| production order | 0.697 | 0.629 | |
| nomic_raw | 0.696 | 0.679 | |
| nomic_prefixed | 0.734 | 0.693 | +0.014 [+0.004, +0.025] |
| gemma2_raw | 0.835 | 0.668 | -0.011 [-0.030, +0.010] |
| gemma2_raw256 | 0.834 | 0.629 | -0.050 [-0.072, -0.026] |

Top-1 is a grade-2 candidate, Jev-labelled: nomic_raw 0.588, nomic_prefixed 0.644 (paired +0.056
[+0.024, +0.088]), gemma2_raw 0.627 (+0.039 [-0.002, +0.078]).

## Reading it
- `embeddinggemma-2` wins clearly on the 29 Gemma-graded queries (+0.139 [+0.058, +0.213]) and
  not at all on the 553 Jev-graded ones. The Gemma set is small, and `embeddinggemma-2` is built
  on the Gemma family, which graded those labels, so that win is not trustworthy on its own.
- Documented task prefixes made `embeddinggemma-2` worse on the first 89 queries (nDCG@5 0.793 vs
  0.835 raw), so KMS's raw-text calls are the right shape for it. That variant was not re-run
  on the large set.
- 256-dim truncation looked free at 29 queries and costs -0.050 at 553.
- Dedup scale: unrelated pairs score higher with `embeddinggemma-2` (median 0.747 vs 0.629). Equal
  false-positive rates need cutoffs near 0.844 and 0.888 instead of 0.78 and 0.88.
- Speed on loaded rym1: ~93-105 ms per text vs ~49 ms for nomic.

## Caveats
- The candidate pools come from production's own search, which already used nomic vectors. This
  measures re-ranking, not first-stage recall.
- Only the 270m tag was tested. The 440m, 570m and 740m tags (714 MB to 1.3 GB) were not.
- Jev labels come from a model too; they agree with Gemma's only partly (see
  `src/scripts/jev-label-agreement.ts`).
- Needs Ollama 0.40.0 or newer; the license is not stated on the model page.

## Candidate improvement (not done)
Adding nomic's `search_query:` / `search_document:` prefixes gave +0.056 top-1 and +0.014 nDCG@5
on the large set and a same-direction gain on the small one. It means changing
`EmbeddingService` to prefix by role and re-embedding the index (`backfill-hnsw-embeddings.ts`).

## Rerun
    python3 scripts/eval/embedder-compare.py plan
    N_JEV=583 EMBED_SLEEP=0.25 nice -n 15 python3 scripts/eval/embedder-compare.py embed
    N_JEV=583 python3 scripts/eval/embedder-compare.py score
