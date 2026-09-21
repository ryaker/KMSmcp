# Jev Experiment 1 — shadow recall rerank

Implements Experiment 1 of [the Jev / System One proposal](./jev-system-one-kms-proposal-2026-09-18.md):
a replaceable `DecisionEngine`, and a shadow evaluation of `unified_search`'s ordering.
**Nothing here changes what `unified_search` returns.**

## Layout

| File | Role |
|---|---|
| `src/decision/types.ts` | `DecisionEngine` interface + provider-neutral Noul / Choice / Score shapes |
| `src/decision/JevDecisionEngine.ts` | The TypeSafe implementation — the only file importing `@typesafe-ai/sdk` |
| `src/decision/onecli.ts` | `fetch` routed through the OneCLI credential gateway |
| `src/decision/recallEvidence.ts` | The three questions, the per-candidate state, the state fingerprint |
| `src/decision/shadowPolicy.ts` | Deterministic policy: shadow score, protection rule, shadow ordering |
| `src/decision/shadowRerank.ts` | Flags + the per-search fan-out |
| `src/decision/engineSlot.ts` | 4 engine calls in flight, process-wide — shared with [Experiment 2](./jev-experiment-2-write-dedup.md) |
| `src/decision/stateFingerprint.ts` | Canonical-JSON sha256 behind the state fingerprint — shared with Experiment 2 |
| `src/decision/decisionLog.ts` | Decision-log row schema + JSONL sink |

`UnifiedSearchTool.search()` calls `startShadowRerank()` after the response is built and
cached. It is not awaited. It is handed the ranked pool, whose leading elements are the
same objects the response returns — so the isolation is a rule (nothing under
`src/decision/` assigns to a candidate, and a test holds that line), not a structural
guarantee.

## Flags

| Env | Default | Effect |
|---|---|---|
| `KMS_JEV_SHADOW_RERANK` | off | `1` (exactly) turns shadow evaluation on → action `shadow_log` |
| `KMS_JEV_SHADOW_REORDER` | off | with the above, `1` also computes and logs a shadow ordering → action `shadow_reorder` |
| `KMS_JEV_SHADOW_TOPK` | `20` | candidates judged per search, = model calls per search. Capped at 50 |
| `KMS_JEV_MODEL` | `jev-latest` | pin a versioned id (`jev-1.13.0`) once thresholds are tuned against it |
| `KMS_DECISION_LOG_PATH` | `~/.kms/decision-log/recall-shadow.jsonl` | where rows go |
| `KMS_JEV_PRICE_INPUT_PER_MTOK` / `…_OUTPUT_…` | `0.042` / `0` | price used for `cost_usd_estimate` |

There is no flag that serves the shadow ordering. That is a later, separate change, gated
on an offline comparison showing precision gains that do not materially damage recall.

## Credentials

Two routes, tried in order; with neither, the shadow path disables itself with one warning.

1. **OneCLI gateway** — `ONECLI_TOKEN` + `ONECLI_GATEWAY` (both required), optional
   `ONECLI_CA_CERT` (default `~/Dev/onecli/certs/ca.pem`). The process authenticates to
   the gateway with the agent token (`Proxy-Authorization: Basic base64("<token>:")`); the
   gateway injects the real TypeSafe key for `*.typesafe.ai`. KMSmcp never holds the key.
   The proxy is scoped to this one client's `fetch` — not `HTTPS_PROXY` — so MongoDB, Mem0
   and Ollama traffic is untouched. On 2026-09-19 this route returned
   `401 access_restricted` for the Mac-wide agent token. The gateway log shows the request
   reaching `gateway::forward`; whether the gateway refused (agent not granted the
   TypeSafe secret) or TypeSafe refused upstream was not established.
2. **`TYPESAFE_API_KEY`** — direct, for environments without a gateway.

## What gets asked

One request per candidate, three questions over `{ query, today, candidate }`:

- `answers_query` — Noul
- `status` — Choice: `current | historical | superseded_context | contradictory | irrelevant`
- `evidence_value` — Score: `no_support → topical_only → indirect → partial → direct`

The state deliberately omits the candidate's rank, every retrieval score, and the stored
`confidence`, so the judgment is independent of the ordering it is compared against and
`knowledge_confidence` cannot leak into a `jev_*` signal. The `status` options overlap
naturally (a current entry can dispute the query's premise; a corrected entry describes
the past), so the question fixes a precedence: irrelevant → contradictory →
superseded_context → historical → current. `contradictory` is judged
against the query's premise and the entry's own claims; cross-candidate contradiction
needs pairwise state and is out of scope for v1.

## What gets logged

One JSON line per search (`kind: "recall_shadow_run"`): provider, requested + resolved
model, `question_schema_version`, `policy_version`, `policy_decision`, query, per-run
latency / usage / cost estimate, `production_order`, `shadow_order`, and per candidate:
`state_fingerprint`, the retrieval-side signals (`retrieval_relevance`,
`vector_similarity`, `ontology_score`, `knowledge_confidence`), the full `jev_probabilities`
for `status` and `evidence_value`, `jev_confidence`, `policy_protected`,
`policy_shadow_score`, `policy_shadow_rank`, request id, latency, usage, cost, error.

Candidate **content is never logged** — ids and fingerprints only — so the log cannot
become a copy of the store that `kms_supersede` / `kms_delete` never reach. The query
text is logged, so the file is forced to `0600` on first write even if it already existed
with looser permissions; if that fails, nothing is written.

## Shadow ordering rules (`recall-shadow-policy/v1`)

- Always a permutation: nothing is dropped.
- A candidate with `_ontologyScore ≥ 0.8` or lexical `_relevance ≥ 0.8` is *protected*: it
  may be promoted, never placed below its production position. Same for a candidate whose
  evaluation failed.
- `contradictory` is not demoted — a disputed premise is what a reader most needs to see.

Weights and multipliers are untuned starting values. Bump the version on any change.

## Offline evaluation

The log is only useful if something reads it. Two files, split at the same line the
harvest pipeline uses — pure logic, then a thin CLI:

| File | Role |
|---|---|
| `src/eval/shadowRunMetrics.ts` | Parsing, ordering metrics, the protection audit, the rate projection, the label join, and report rendering. No I/O |
| `src/scripts/shadow-eval-report.ts` | Reads the logs, prints the report |

```sh
npx tsx src/scripts/shadow-eval-report.ts [--target 200] [--k 5] [--since <iso>] \
    [--log <path> ...] [--labels <path>] [--json]
```

It reads `~/.kms/decision-log/recall-shadow.jsonl` and `eng-recall-shadow.jsonl` by
default and reports each plus the combined set.

**Query text is never printed.** The log is forced to `0600` because a query can carry
anything the caller pasted, including a credential; the report is meant for a PR body or a
chat message, so it identifies runs by id and `sha256` prefix instead.

The report separates two kinds of number, and the distinction is the point:

- **Invariants** — permutation, protection, signal consistency, provider faults. These are
  falsifiable from the log alone, and a non-zero is a defect at *any* sample count.
- **Quality** — reorder rate, top-1 / top-3 agreement, mean displacement. These measure how
  much the policy *would* change what a reader sees. They say nothing about whether it is
  better; that needs relevance labels the store does not have. With no labels the section
  prints `NONE — quality delta NOT computed` rather than a zero, because a zero reads as a
  measurement.

Harvest Phase 0's `ClaudeLabels.*` entries are **not** a substitute — those are label
*statements* addressed to no candidate id, so joining them to a run would invent a
relevance judgment. `labelAgreement` returns `null` for that reason.

At 200 samples, [the promote checklist](./jev-experiment-1-promote-checklist.md) is what a
human works through. Nothing promotes automatically.

## Tests

`npx jest src/__tests__/decision- src/__tests__/UnifiedSearchTool.shadowRerank` — all
mocked, no network. Live smoke (skipped unless opted in):

```sh
set -a; source ~/nanobanana-mcp-server-local/.env; set +a
KMS_JEV_LIVE_SMOKE=1 npx jest src/__tests__/decision-JevDecisionEngine.live.test.ts
```
