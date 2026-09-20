# Jev Experiment 2 — shadow write-time dedup relation

Implements the second experiment of [the Jev / System One proposal](./jev-system-one-kms-proposal-2026-09-18.md)
("recall reranking → **write-time dedup/correction classification** → …"), on the
`DecisionEngine` that [Experiment 1](./jev-experiment-1-shadow-rerank.md) introduced.
**Nothing here changes what `unified_store` stores, refuses, supersedes or returns.**

Jev proposes; deterministic KMS policy decides what a proposal may do. In this version it
may do exactly one thing: be logged.

## Layout

| File | Role |
|---|---|
| `src/decision/writeDedupRelation.ts` | The questions (Choice `relation` + five Nouls), the per-pair state, the state fingerprint |
| `src/decision/writeDedupPolicy.ts` | Deterministic policy: judgments → proposed action; per-write aggregation; the (empty) auto-action set |
| `src/decision/writeDedupShadow.ts` | Flags, the per-write fan-out, the log row schemas |
| `src/decision/engineSlot.ts` | Process-wide cap of 4 in-flight engine requests — shared with the recall shadow path |
| `src/decision/stateFingerprint.ts` | Canonical-JSON sha256, shared with the recall shadow path |

## Where it is hooked

It extends the existing dedup gate; there is no parallel path. `UnifiedStoreTool.store()`
calls `startWriteDedupShadow()` from inside the Tier 1 block (DG-T1-B), after
`findSimilar` has returned and the gate has made its decision:

- **`dedup_required`** (refuse / confirm band) — just before the response is returned.
  The Tier 2 Haiku `llm_relation` for each candidate is logged beside Jev's, so the two
  judges can be compared row by row.
- **proceeded** (top candidate below the confirm band) — the pairs the gate waved through
  are where its false negatives would be (a contradiction that embedded at 0.7), so
  candidates at or above `KMS_JEV_WRITE_DEDUP_MIN_SIM` are judged too.

Not judged: Tier 0 exact fingerprint matches (identical text needs no judge), and
`action=` retries, which skip the gate and so have no candidates.

The call is fire-and-forget and is handed copies of candidate fields, the new assertion's
text, and a read-only `findById`. It holds nothing that can store, flag, supersede or
delete — "Jev never directly mutates storage" is structural, not a convention.

## Flags

| Env | Default | Effect |
|---|---|---|
| `KMS_JEV_WRITE_DEDUP` | off | `1` (exactly) turns shadow evaluation on → `policy_decision: shadow_log` |
| `KMS_JEV_WRITE_DEDUP_ACT` | off | **Reserved, hard-disabled.** `WRITE_DEDUP_AUTO_ACTIONS` is empty; setting this logs a warning and `act_requested: true`, nothing else |
| `KMS_JEV_WRITE_DEDUP_MIN_SIM` | `0.6` | candidates under this cosine are not judged |
| `KMS_WRITE_DEDUP_LOG_PATH` | `~/.kms/decision-log/write-dedup-shadow.jsonl` | where rows go (0600, separate from the recall log) |
| `KMS_JEV_MODEL`, `KMS_JEV_PRICE_*` | as Experiment 1 | shared engine settings |

At most 5 candidates are judged per write (the gate's own `topK`), one request each.
Credentials are Experiment 1's: OneCLI gateway (`ONECLI_TOKEN` + `ONECLI_GATEWAY`) first,
`TYPESAFE_API_KEY` otherwise; with neither, the path disables itself with one warning.

## What gets asked

One request per candidate, six questions over `{ new_assertion, candidate }`:

- `relation` — Choice: `duplicate | supersedes | supersedes_reverse | complement | contradicts | unrelated`
  (the Tier 2 judge's six relations, so the two are comparable)
- `same_subject`, `new_adds_information`, `claims_conflict`, `new_marks_correction`,
  `candidate_marks_correction` — Nouls

The Choice is relative — it must put its probability somewhere — and TypeSafe documents
that a Choice and a Noul on the same point are not arithmetically tied. So the Nouls are
asked as absolute checks on the facts each relation rests on, and the policy only proposes
something consequential when both agree.

Two relation pairs overlap naturally (a correction necessarily conflicts with what it
corrects; a duplicate and a complement differ only in whether anything is added), so each
option names the neighbour it excludes and the question fixes a precedence. The state
omits the cosine, the gate band, the Tier 2 relation and the stored `confidence`, so the
judgment is independent of every signal it is later compared against. It carries no dates:
the only ordering that matters is fixed by construction and stated in the question, and
Jev compares dates unreliably. Entries are data that may argue for their own
classification (Jev does not treat state as hostile); the instructions say so explicitly,
and in shadow mode a steered answer costs one wrong log row.

## Policy (`write-dedup-policy/v1`)

The asymmetry it is built on: storing a redundant entry costs one row that
`kms_supersede` / `kms_delete` can retire; refusing a non-redundant one loses knowledge
nobody knows is missing.

| Proposal | Requires |
|---|---|
| `suggest_supersede` | `supersedes` ≥ 0.8 **and** `same_subject` ≥ 0.8 **and** `new_marks_correction` ≥ 0.7 |
| `suggest_keep_existing` | `supersedes_reverse` ≥ 0.8 **and** `same_subject` ≥ 0.8 **and** `candidate_marks_correction` ≥ 0.7 |
| `escalate_contradiction` | `P(contradicts)` ≥ 0.25 **or** `claims_conflict` ≥ 0.5 — unless one of the two rows above already established the correction |
| `suggest_skip_duplicate` | `duplicate` ≥ 0.9 **and** confidence ≥ 0.8 **and** `same_subject` ≥ 0.8 **and** `new_adds_information` ≤ 0.2 |
| `store_complement` | `complement` ≥ 0.6, no conflict signal |
| `store_new` | `unrelated` ≥ 0.6 or `same_subject` ≤ 0.2, no conflict signal |
| `review` | anything else — including a "conflict" between entries judged to be about different things |

The proposal for the write is the most consequential per-candidate proposal, in the order
above with `review` between `suggest_skip_duplicate` and `store_complement`. No proposal
deletes or edits in place; the only one that touches an existing entry is a supersede,
which preserves the old entry and the chain.

**The thresholds are cautious starting points, not calibrated values.** Nothing has been
fitted against production judgments yet — that is what the log is for.

## What gets logged

Two row kinds, one JSONL file:

- `write_dedup_shadow_run` — provider, requested + resolved model, `question_schema_version`,
  `policy_version`, `policy_decision` (always `shadow_log`), `act_requested`, the gate's
  outcome / band / thresholds, latency / usage / cost estimate, `policy_proposal` +
  `policy_proposal_target_id`, and per candidate: `vector_similarity`, `gate_band`,
  `tier2_llm_relation`, `state_fingerprint`, the full `jev_probabilities` for `relation`,
  `jev_confidence`, every Noul's `jev_probability`, `policy_proposal`, `policy_reasons`,
  request id, latency, usage, cost, error.
- `write_dedup_resolution` — written when `unified_store` is retried with an `action`:
  which action the caller chose and against which id. This is the label the proposals are
  scored against. Joins to the run on `assertion.content_sha256`.

Neither row contains entry content or the caller's `reason` text: the new assertion is
referenced by id, sha256 and length. A log that copied content would be a second knowledge
base that `kms_supersede` / `kms_delete` never reach.

## Before `KMS_JEV_WRITE_DEDUP_ACT` can mean anything

1. Run shadow on real writes; join runs to resolutions.
2. Measure, per proposal, agreement with what callers chose — and separately with the
   Tier 2 judge. The number that matters most is `suggest_skip_duplicate` precision.
3. Only a proposal whose error is cheap and whose agreement is demonstrated goes into
   `WRITE_DEDUP_AUTO_ACTIONS`. The first candidate is `store_complement` on a write the
   gate already let through: it adds a link to a write that was happening anyway.
   `suggest_skip_duplicate` and `suggest_supersede` should stay caller-confirmed.

## Tests

- `decision-writeDedupPolicy.test.ts` — every rule, the conservative fallbacks, aggregation, the empty auto-action set.
- `decision-writeDedupShadow.test.ts` — flags, state contents, fan-out cap + floor, failure rows, no content in the log, JSONL file 0600.
- `UnifiedStoreTool.writeDedupShadow.test.ts` — flag off = no calls; flag on = identical store result and identical backend writes on both gate outcomes, even with a maximally wrong engine and `ACT=1`; resolution rows.
- `decision-JevDecisionEngine.live.test.ts` — live, behind `KMS_JEV_LIVE_SMOKE=1`.

Live smoke, 2026-09-19, `jev-1.13.0` via OneCLI: six hand-written pairs, one per relation,
all six classified as intended (≥ 0.94 on the chosen option), including the direction
check (`supersedes_reverse` → `suggest_keep_existing`). ~1,380 input tokens per pair
(≈ $0.00006), 130–750 ms. Six unambiguous pairs establish that the questions are read the
right way round — not that the thresholds are right.
