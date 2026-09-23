# Jev Experiment 1 — promote checklist (at 200 shadow samples)

**Nothing in this document promotes anything.** There is no auto-promote, no scheduled
flip, and no flag that serves a shadow ordering. This is the list a human works through,
by hand, when the sample gate is met — and it exists because a sample count on its own is
the most plausible way this change gets shipped without ever having been evaluated.

Companion to [`jev-experiment-1-shadow-rerank.md`](./jev-experiment-1-shadow-rerank.md)
(what the experiment is) and the report CLI:

```sh
npx tsx src/scripts/shadow-eval-report.ts              # human-readable
npx tsx src/scripts/shadow-eval-report.ts --json        # same numbers, machine-readable
```

## The gate, and what it is not

Rich's gate before bi-directional (production) reorder: **100–200 on-read shadow samples.**

That number is a _power_ threshold — enough runs for the invariant checks and the cost
figures to have teeth. It is **not** evidence that the shadow ordering is better. Every
quality number the report prints (`reordered`, `top-1 agreement`, `top-3 overlap`,
`mean |rank Δ|`) measures how much the policy _would_ change what a reader sees. A 98%
reorder rate is a blast radius, not a gain. Whether the new order is an improvement needs
relevance labels, which KMS does not have today.

So the checklist below has two halves that must both pass: **invariants** (falsifiable
from the log alone) and **quality** (needs the label set). A clean invariant half with no
label set is a _not yet evaluated_ experiment, not a passing one.

## Current status — 2026-09-20

| Metric | Value |
|---|---|
| runs | 131 (personal 26 + eng 105) |
| target | 200 (69 remaining) |
| observed window | 23.4 h, 134.2 runs/day |
| ETA at observed rate | ~12 h (extrapolated; assumes sampling continues) |
| reordered | 129/131 (98.5%) |
| mean \|rank Δ\| | 5.72, max 19 |
| permutation violations | 0 |
| protection violations | 0 |
| signal-consistency disagreements | 0 |
| candidate errors / failed | 0 / 0 |
| cost | $0.001143/run, $0.1497 total |
| run latency | p50 2343 ms, p95 7219 ms |
| model / policy | `jev-1.13.0` / `recall-shadow-policy/v1` |
| labels | **NONE** — quality delta not computed |

The ETA is extrapolation from a window spanning under a day, so it moves. Re-run the
report rather than trusting this table.

## Before promotion — invariants

Each of these must hold _on the full run set at the moment of promotion_, not on an
earlier sample. Re-run the report and read the `INVARIANTS` block; do not reuse this
document's numbers.

- [ ] **Sample count ≥ 100**, and the gate is being read at the count you actually have —
      not at a count from an earlier run. `runs` in the `GATE` block is the number.
- [ ] **`permutation` = 0.** The shadow ordering must be a permutation of production.
      Non-zero is a defect at _any_ sample count and blocks promotion outright: something
      was dropped or duplicated, and the ordering cannot be compared to anything.
- [ ] **`protection` = 0.** No pinned candidate (`_ontologyScore ≥ 0.8`,
      `_relevance ≥ 0.8`, or unjudged) was placed below its production position. This is
      the one part of the shadow ordering that is a promise rather than a preference.
- [ ] **`signal consistency` = 0.** The logged `policy_protected` flag must still be
      re-derivable from the logged `retrieval` signals. Non-zero means the flag and the
      signals it claims to come from have drifted apart, which makes the violation count
      above unsound — treat a non-zero here as blocking the line above it.
- [ ] **`protection fired` > 0.** As of 2026-09-20 the rule has **never fired** across
      2552 candidates. Zero firings means invariant 2 is exercised only by unit tests, and
      the report says so explicitly. Either find a run set where it fires, or write down an
      explicit decision that promoting an unexercised invariant is acceptable — do not let
      the `0 violations` line above imply coverage it does not have.
- [ ] **`provider` faults = 0** (candidate errors and `candidates_failed`). A run where
      the engine failed still logs, but its ordering is not evidence about the policy.
- [ ] **Cost and latency read and accepted.** Compare against the current on-read path's
      budget; the shadow path is fire-and-forget so its latency today is not on the
      request path, but a served reorder would be. Note the p95, not the mean.
- [ ] **`skipped` lines understood.** `malformed`, `partial tail` and `shadow-log-only`
      counts should be explained, not merely small. A partial tail is normal on a live log;
      a non-zero `malformed` is not.

## Before promotion — quality

- [ ] **A real label set exists** for a meaningful subset of these queries, produced by a
      judging pass (or the frozen-pool harness in `src/eval/rankers.ts`), and passed via
      `--labels`. Shapes accepted: JSONL `{"query": "…", "labels": {"<id>": 1}}`, or one
      JSON object `{"<query>": {"<id>": 1}}`.
- [ ] **The report shows `P@k`, `nDCG@k` and `MRR` rows**, with the deltas, rather than
      `labels: NONE`. If it still prints `NONE`, the quality half has not been evaluated.
- [ ] **The shadow ordering is not worse** on the metrics that matter for this store.
      A reorder policy that improves precision while losing the top-1 answer is a
      regression for a memory store, where the top hit is usually the one returned.
- [ ] **The result is stated with its denominator** — how many of the N runs were labeled,
      how many unlabeled runs were excluded. The report prints both; a delta measured on 8
      of 200 runs is not a 200-sample result.

**Do not substitute Harvest Phase 0 labels for this.** Those entries
(`subject: ClaudeLabels.<kind>`, `provenance: claude-transcript`) are Rich's corrections,
rules and preferences — label _statements_ addressed to no candidate id. Joining them to a
recall run would invent a relevance judgment, which is the one thing this metric must not
do. `labelAgreement` returns `null` rather than a flattering zero for exactly this reason.

## The flip (when, and only when, everything above is checked)

1. Record the decision: the sample count, the report output, the label set used and where
   it lives. Attach it to the promotion PR.
2. Change the code, not just the environment. Serving the shadow ordering is a code change
   with a flag — the shadow path is deliberately fire-and-forget and off the response
   path; wiring a served ordering into `UnifiedSearchTool.search()` is new work, not a
   config flip.
3. Bump `SHADOW_POLICY_VERSION` (`recall-shadow-policy/v1` → `v2`) if any weight, threshold
   or rule changes. The version is the join key for every past row; a silently retuned
   policy makes the accumulated log unreadable.
4. Ship it dark, then ramp. Keep the log running after promotion — the shadow row set
   becomes the regression baseline for the served ordering.
5. Have the rollback written down before the flip: which flag reverts, and what the
   pre-promotion ordering was.

## Explicitly out of scope here

- No auto-promote, and no cron job that flips anything at N=200.
- No change to the protection thresholds to make the rule "fire" — that would be tuning an
  invariant to fit the data.
- Promotion does not authorize removing the shadow log, the decision-log schema, or the
  `0600` file mode. The log is how a served ordering gets evaluated later.
