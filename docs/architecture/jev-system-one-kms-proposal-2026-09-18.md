# Jev / System One in KMS

**Status:** Architecture proposal (authoritative for Experiment 1)
**Date:** 18 September 2026

## Executive summary

Jev is a strong candidate for the semantic-decision tier between deterministic KMS machinery and expensive generative reasoning. It should not become another datastore or replace SparrowDB, embeddings, hybrid retrieval, SparrowOntology, MongoDB/Mem0, or the KMS correction/audit mechanisms.

> **Embeddings find candidates. The ontology defines legal structure. Jev makes bounded semantic judgments. Deterministic KMS code decides what those judgments may do. Generative models handle genuinely open-ended reasoning.**

Recommended experiment order: **recall reranking → write-time dedup/correction classification → ontology-constrained relationship extraction → query planning.**

## DecisionEngine

Do not scatter TypeSafe/Jev calls through KMSmcp. Introduce a replaceable `DecisionEngine` whose initial implementation uses Jev (`@typesafe-ai/sdk` / HTTP System One).

Log: provider/resolved model version, question/schema version, state fingerprint, full probability distributions, Jev confidence, deterministic policy version, resulting action, latency, cost.

## Signal namespaces (do not conflate)

- `vector_similarity` — embedding proximity
- `retrieval_relevance` — usefulness for current query
- `knowledge_confidence` — quality of stored knowledge
- `jev_probability` / `jev_confidence` — Jev answer distribution
- `policy_decision` — deterministic KMS action

## Experiment 1 — recall reranking (THIS SESSION)

Preserve existing hybrid retrieval. Candidates in → DecisionEngine evidence evaluation → log + optional reorder. **Shadow mode:** do not discard strong deterministic/ontology matches; do not change production ranking unless behind an explicit flag defaulting OFF.

Per candidate questions:
- `answers_query`: Noul
- `status`: Choice of `current | historical | superseded_context | contradictory | irrelevant`
- `evidence_value`: Score from `no_support` through `direct`

Shipping gate later: precision gains must not materially damage recall. This session: instrumentation + shadow path + tests/smoke.

## Non-goals this session

No write-time gate, no ontology edge creation, no query planning, no replacing embeddings/hybrid/SparrowOntology, no inventing ontology vocabulary, no erasing correction history.
