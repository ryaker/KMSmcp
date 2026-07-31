# KMS Context Injection Quality Spec

**Status**: Signed off 2026-04-12 — Leg-0 implementation unblocked
**Created**: 2026-04-12
**Author**: Rich Yaker + Claude (ultraplan session)
**Gates**: Leg-1 implementation blocked on Leg-0 exit criteria (§6).

---

## Context

KMS context injection (the `kms-context-fetch.py` UserPromptSubmit hook calling `unified_search` and prepending results to the agent's turn) is currently **not measured**. The polyglot store keeps growing, but we have no idea how often the injected items are on-topic, how often the agent actually uses them, or how often they're contradicted in flight. Anecdotally, the on-topic rate is roughly **22%**, which means ~80% of the injection budget is noise that pushes useful tokens out of context and trains the agent to ignore the bundle.

The corrective tools (`kms_supersede` / `kms_flag` / `kms_delete` — `src/tools/UnifiedStoreTool.ts:404-619`) exist and work, but with no feedback signal, wrong/stale entries don't get pruned and good entries don't get reinforced. The store has no self-healing loop.

Before writing any code, the user wants a spec that pins down:

- a quantitative definition of "working right"
- the measurement infrastructure to produce those numbers
- a feedback loop from measurement back into ranking
- a closed loop with the corrective tools
- a phased rollout (Mem0 leg first) with kill criteria
- a failure-mode catalog

The spec is the contract the implementation will be judged against. **Sign-off on the spec gates leg-1 implementation.**

---

## Deliverable

A single markdown spec at:

```text
docs/CONTEXT_INJECTION_QUALITY_SPEC.md
```

This is the only file created by this plan. No code, no hooks, no schema migrations. Implementation lives in a follow-up plan that references this spec.

`docs/` is where the existing technical specs live (`TECHNICAL_SPEC_GENAI_PATTERNS.md`, `IMPLEMENTATION_GUIDE.md`, etc.) — same naming convention, same audience.

---

## Shape of the change

```text
┌─────────────────────────────────────────────────────────────┐
│  This plan                                                  │
│  ─────────                                                  │
│  writes → docs/CONTEXT_INJECTION_QUALITY_SPEC.md            │
│                                                             │
│  spec defines:                                              │
│  ┌────────────────┐   ┌──────────────────┐                  │
│  │ §2 Metrics     │──▶│ §3 Measurement   │                  │
│  │  on-topic %    │   │  Stop-hook       │                  │
│  │  usage %       │   │  scorer →        │                  │
│  │  contradiction │   │  kms_quality_log │                  │
│  │  discovery %   │   │  (Mongo coll.)   │                  │
│  └────────────────┘   └────────┬─────────┘                  │
│                                │                            │
│                                ▼                            │
│                       ┌──────────────────┐                  │
│                       │ §4 Feedback loop │                  │
│                       │  signals decay/  │                  │
│                       │  boost effective │                  │
│                       │  confidence in   │                  │
│                       │  ranker          │                  │
│                       └────────┬─────────┘                  │
│                                │                            │
│                                ▼                            │
│                       ┌──────────────────┐                  │
│                       │ §5 Corrective    │                  │
│                       │  loop: contradict│                  │
│                       │  → suggest       │                  │
│                       │  kms_supersede   │                  │
│                       │  inline          │                  │
│                       └────────┬─────────┘                  │
│                                │                            │
│                                ▼                            │
│                       ┌──────────────────┐                  │
│                       │ §6 Phased        │                  │
│                       │  rollout:        │                  │
│                       │  Mem0 leg → 1wk  │                  │
│                       │  → kill criteria │                  │
│                       │  → leg 2/3       │                  │
│                       └────────┬─────────┘                  │
│                                │                            │
│                                ▼                            │
│                       ┌──────────────────┐                  │
│                       │ §7 Failure modes │                  │
│                       │  + revert plan   │                  │
│                       └──────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
       user signs off
              │
              ▼
   follow-up plan: implement leg 1
   (Stop-hook scorer + kms_quality_log
    + ranker hook in UnifiedSearchTool.rankResults
    src/tools/UnifiedSearchTool.ts:430-444)
```

---

## §1 Context & current state (½ page)

- The polyglot architecture (Mem0 / Neo4j / MongoDB) and where injection happens (`kms-context-fetch.py` → `unified_search` → prepended to UserPromptSubmit).
- The corrective tools that already exist: update/delete/flag/supersede/reap in `src/tools/UnifiedStoreTool.ts:404-619`. Reference, don't restate.
- What we don't have: any measurement, any feedback loop, any signal back to ranking.
- Anecdotal baseline: **~22% on-topic injection rate**. Flag this as anecdotal — leg 1 produces the real number.

---

## §2 Definition of "working right" — quantitative metrics

Each metric needs: name, formula, who computes it, baseline (if known), target, sample window.

| Metric | Formula | Computed by | Baseline | Target | Window |
|---|---|---|---|---|---|
| **On-topic injection rate** | `(# injected items judged relevant to user prompt) / (# injected items)` | Stop-hook scorer (LLM judge over `{prompt, injected_item}`) | ~22% (anecdotal) | ≥80% | rolling 7d |
| **Usage rate** | `(# injected items the next assistant turn referenced or acted on) / (# injected items)` | Stop-hook scorer (LLM judge over `{injected_item, assistant_response}`) | unknown | ≥50% | rolling 7d |
| **Contradiction rate** | `(# injected items the assistant explicitly contradicted) / (# injected items)` | Stop-hook scorer; auto-stages a `kms_supersede` suggestion | unknown | ≤5% | rolling 7d |
| **Discovery rate** | `(# warranted corrections subsequently resolved via a corrective tool) / (# warranted corrections raised)` | Stop-hook scorer (judges from contradiction signal); resolution matched by `item_id`, not by turn | ~0% | ≥70% | rolling 7d |

Each metric definition spells out: what counts as a "use," what counts as a "contradiction" (explicit only, not omission), and what counts as "warranted" for discovery. **The judge prompts go in an appendix so they're version-controlled.**

**Discovery rate spans sessions — measure it per item, never per turn.** §5 surfaces
correction suggestions in the *next* session, so the turn that raises a warranted
correction and the turn that resolves it are different turns, usually in different
sessions. A same-turn numerator would therefore read ~0% forever regardless of how
well the loop works. Concretely:

- When the scorer judges a correction warranted, it writes an open record keyed by
  the offending `item_id` (not `turn_id`), with the raising `session_id`/`turn_id`.
- Any later `kms_supersede` / `kms_flag` / `kms_update` naming that `item_id` closes
  the record, whenever and wherever it happens.
- The rolling-7d window is applied to the **raising** timestamp, and a record is
  counted resolved if it closes within **14 days** of being raised. Corrections
  resolved after that lapse count as misses, so the metric cannot be gamed by an
  unbounded tail.
- An `item_id` with an already-open record does not raise a second one; repeated
  contradictions of the same item increment a counter on the existing record.

**Why these four**: they're orthogonal. On-topic rate measures retrieval quality, usage rate measures whether on-topic results were actually load-bearing, contradiction rate flags wrong stored facts, discovery rate measures whether the corrective tools are reaching daily flow. You can't game one without moving another.

---

## §3 Measurement infrastructure

- **Where**: Stop-hook addition in `~/.claude/settings.json` running an async scorer script. **Must NOT block the user** — fire-and-forget, write to a queue.
- **What it captures per turn**:
  - `session_id`, `turn_id`, `timestamp`
  - `user_prompt` (truncated)
  - `injected_items[]` — id, source backend, **`excerpt`: the first 500 characters of the item's content, truncated (never the full text)**, plus `content_length` so truncation is detectable, and confidence at time of injection. The log stores the excerpt only; the full content is retrievable from the source backend by `id` when a scorer or auditor needs it. Storing full text here would duplicate the corpus into the log and blow past the TTL collection's size budget.
  - `assistant_response` (truncated)
  - `tool_calls[]` (especially `kms_supersede`/`kms_flag`/`kms_update`)
- **Where it lands**: a new collection `kms_quality_log` **in the existing KMS MongoDB database** (the connection in `src/storage/MongoDBStorage.ts:23-44` is reused — no new infra, no new database). One document per turn. TTL index at 90 days for raw turns; rollups stay forever.
- **Scoring**: a small Anthropic-API call with a fixed judge prompt. **Model: Haiku 4.5** (`claude-haiku-4-5-20251001`). Runs async after the Stop hook fires. Writes scores back into the same `kms_quality_log` document. If the API call fails, the raw turn is preserved and re-scoreable.
- **Judge validation gate (part of Leg 0 exit)**: before any ranking change ships, the Haiku judge is evaluated against **50 hand-labeled turns**. Required agreement: **≥85%** across all four metrics. If agreement < 85%, auto-upgrade to **Sonnet 4.6** (`claude-sonnet-4-6`) and re-run the 50-turn validation. If Sonnet fails the same bar, halt Leg 0 and escalate — the judge prompt needs rework, not a bigger model.
- **Rollups**: a daily script aggregates raw turns into `kms_quality_rollup` keyed by date — that's what dashboards/alerts read. Cheap to query, durable beyond the 90d TTL.

The spec includes the JSON schema for both collections and the judge prompt. *(Drafted during Leg 0 implementation, reviewed before the 50-turn validation runs.)*

---

## §4 Feedback loop into ranking

The structural fix. Today `UnifiedSearchTool.rankResults` (`src/tools/UnifiedSearchTool.ts:430-444`) sorts purely on `result.confidence`. The spec defines an **effective confidence** that combines stored confidence with usage signal:

```text
effective_confidence = max(0, stored_confidence × (1 + α·usage_score − β·contradiction_score))
```

- The `max(0, …)` clamp is required, not cosmetic. At the default **β=2.0** any
  `contradiction_score > 0.5` drives the multiplier negative, and a negative
  effective confidence would sort *above* a legitimate low-confidence item under a
  descending sort — inverting the penalty into a reward. Clamped, a heavily
  contradicted item floors at 0 and ranks last, which is the intent.
- `usage_score`: rolling EMA (smoothing factor **γ=0.3**) over the item's
  `(uses) / (injections)` from `kms_quality_rollup`.
- `contradiction_score`: rolling EMA (smoothing factor **γ=0.3**) over the item's
  `(contradictions) / (injections)`.
- γ is shared by both EMAs so responsiveness is symmetric: at 0.3 an item's score is
  dominated by roughly its last 5–6 injections, fast enough to react to a correction
  without thrashing on a single anomalous turn. Any implementation must read γ from
  one shared constant rather than redeclaring it per-metric.
- `α`, `β` are constants set in the spec (start: **α=0.5, β=2.0** — contradictions punish harder than uses reward).
- An item with no injection history falls back to stored confidence (no penalty for being new).

The spec specifies this gets read from a per-item field on the entry (`metadata.quality.effective_confidence`) updated by the daily rollup, **not** computed on every query — the rank path stays cheap. The `rankResults` change is one line: read `metadata.quality.effective_confidence ?? confidence`.

Stored facts that consistently waste injection budget naturally fade out of the top-N. This is what makes it self-healing.

---

## §5 Closed loop with corrective tools

When the scorer marks `contradiction=true` for an injected item, it writes a `suggested_correction` document to `kms_quality_log` with the `old_id`, the contradicting assistant statement, and a draft `kms_supersede` payload. The next session's `kms-context-fetch.py` hook surfaces pending suggestions in the injected bundle:

> ⚠️ Pending correction: entry `abc-123` was contradicted in turn `xyz`. Suggested supersede: "..." — confirm with `kms_supersede(abc-123, ...)` or dismiss.

Discovery rate goes up because the agent doesn't have to remember to correct — the suggestion is in the bundle on the next relevant turn. Suggestions that go unconfirmed for 14 days auto-flag the original as `UNVERIFIED`.

---

## §6 Phased rollout with kill criteria

| Phase | Scope | Entry criteria | Exit criteria (proceed) | Kill criteria (revert) |
|---|---|---|---|---|
| **Leg 0 — Measurement only** | Stop-hook scorer + `kms_quality_log` + rollup, no ranking change | spec signed off | 7 days of clean data, judge prompt validated against 50 hand-labeled turns (>85% agreement) | Scorer adds >500ms latency to Stop hook; judge agreement <70% |
| **Leg 1 — Mem0 leg of feedback loop** | `effective_confidence` applied to Mem0 results only in `rankResults` | leg 0 exit met | 7 days; Mem0 on-topic rate improves by ≥10pp; usage rate improves by ≥5pp; no regression in contradiction rate | Any of: Mem0 on-topic drops, latency p95 >150ms, false-flag rate >10% (good entries demoted then resurrected) |
| **Leg 2 — Neo4j leg** | Same mechanism, Neo4j results | leg 1 exit met | same thresholds | same |
| **Leg 3 — MongoDB leg + closed corrective loop** | MongoDB + §5 suggestion surfacing | leg 2 exit met | overall on-topic ≥80%, discovery rate ≥70% | regressions or judge drift |

Each leg gets a **1-week measurement window minimum**. The spec is explicit: if a leg regresses, revert (one config flag), don't patch in flight. Rethink before re-attempting.

**Why Mem0 first**: cheapest signal recovery. Mem0's memories are LLM-extracted and tend to be the noisiest leg of the polyglot — biggest absolute gain from filtering, lowest blast radius if the ranker change misbehaves (the other two legs are untouched).

---

## §7 Failure modes & revert

| Mode | Detection | Mitigation |
|---|---|---|
| Scorer adds latency to Stop hook | p95 hook duration metric in `kms_quality_rollup` | Make scorer fully async (queue → worker), not inline |
| Judge model drift / disagreement | Weekly hand-label sample (10 turns) compared to judge scores | Re-anchor judge prompt; treat as model-version event |
| Effective confidence collapses good entries | `false_demotion_rate` = items demoted then later promoted within 7d | If >10%, raise α (uses count more), drop β |
| Supersede chains grow unbounded | Chain depth in `metadata.supersedes` | Cap at depth 5; reaper compacts |
| Self-reinforcing loop (high-confidence item gets used because high-confidence) | Compare usage rate of items above/below median confidence; if ratio >3x, flag | Add small random exploration term to ranking (ε-greedy) |
| `kms_quality_log` grows unbounded | Collection size monitor | TTL index at 90d on raw; rollups stay |
| **Revert** | A single env var `KMS_QUALITY_RANKING_ENABLED=false` | Falls back to plain confidence sort. No data lost — `kms_quality_log` keeps recording |

---

## §8 Decisions (signed off 2026-04-12)

All four open questions resolved. Rationale recorded so a future reader knows *why*, not just *what*.

### 1. Judge model: **Haiku 4.5 with Sonnet 4.6 auto-fallback**

The judge task is a narrow classification with short inputs and tiny outputs — Haiku's sweet spot. Contradiction is constrained to "explicit only, not omission" (§2), which removes the subtle-inference cases where Haiku underperforms. Cost at 200 turns/day: ~$7/year Haiku vs ~$70/year Sonnet — not load-bearing either way, but Haiku is cheaper **and** the §3 validation gate (50 hand-labeled turns, ≥85% agreement) gives us an empirical check before any ranking change ships. If Haiku misses the bar, the gate auto-upgrades to Sonnet.

### 2. Injected-item content excerpt: **full text, first 500 chars**

KMS is a single-user personal knowledge store. There are no multi-tenant PII concerns — all stored content is already on Rich's machine under the same `user_id`. The debugging story (post-hoc "why did this entry get demoted?" investigations against the historical log) is significantly better with readable content than with opaque hashes. Hash-only would only be worth it for multi-tenant exposure, which doesn't apply here.

### 3. Collection location: **same MongoDB database as the polyglot store, new collection**

At expected volume (~200 turns/day × ~4 injected items = ~1MB/day), the performance difference between "new collection in existing DB" vs "separate DB on same instance" is essentially zero — same WiredTiger engine, same connection pool, same replica set. Separate DBs would only matter at gigabytes of daily write volume (3+ years away at current pace) or if we wanted independent backup schedules. If that future arrives, a one-liner `mongodump --collection=kms_quality_log | mongorestore --db=kms_quality` migrates without downtime.

### 4. α / β starting values: **α = 0.5, β = 2.0**

The asymmetry (β 4× larger than α) embodies the principle *"wrong information is more costly than missing information"* — a single contradiction should punish ranking as hard as four uses reward it. Concrete effect:
- **Good entry** (used 80%, never contradicted): `effective = stored × 1.40` → promoted above stored confidence
- **Wrong entry** (used 10%, contradicted 30%): `effective = stored × 0.45` → demoted by more than half

If operational telemetry shows these defaults are too aggressive (the §7 `false_demotion_rate` monitor triggers at >10%), the mitigation is explicit: raise α, drop β. The values are a single constant pair defined in one place — tunable in one line if they need to change.

---

## Files this plan touches

- `docs/CONTEXT_INJECTION_QUALITY_SPEC.md` — **created**

That's it. No code, no settings, no schema. Implementation is a separate plan that will reference this spec and modify:

- `src/tools/UnifiedSearchTool.ts:430-444` (`rankResults`)
- `src/storage/MongoDBStorage.ts:23-44` (new collections)
- `~/.claude/settings.json` (Stop hook addition)
- a new scorer script (path TBD in implementation plan)

---

## Verification

The deliverable is a spec, so verification is review-driven, not test-driven:

1. Open `docs/CONTEXT_INJECTION_QUALITY_SPEC.md` and confirm all eight sections are present and self-contained.
2. Confirm each metric in §2 has a formula, a baseline (or "unknown"), a target, and a window — no vibes language.
3. Confirm §3 references existing infrastructure (MongoDB connection, existing Stop-hook slot in `~/.claude/settings.json`) instead of inventing new infra.
4. Confirm §6 has explicit numeric kill criteria for every phase, and the revert mechanism is one flag.
5. Walk the table in §7 and confirm every failure mode has both a detection and a mitigation.
6. Confirm §8 lists the user-facing decisions still open — no hidden assumptions.

**Sign-off** = the user (1) approves the four metric definitions, (2) picks defaults for the §8 open questions, (3) green-lights leg 0 implementation. After sign-off, the implementation plan gets opened against this spec.
