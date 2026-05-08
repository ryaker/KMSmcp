---
name: kms-reconcile-pass
description: >
  Run a full-reconciliation pass over a topic cluster in Richard's Personal KMS —
  identify supersede candidates, contradictions, and near-duplicates, then PROPOSE
  corrective actions for human approval before dispatching. Triggers on "reconcile
  KMS", "clean up KMS", "audit KMS for <topic>", "weekly KMS pass", "find
  contradictions in KMS", "drain KMS dedup debt", "reconcile <topic>", or when
  Rich asks to clean up an over-written subject area. NEVER silently applies
  corrections — every supersede/update/delete needs explicit user approval first.
  Drains the "0 corrections vs N writes" debt the dedup gate spec was written to
  fix. Do NOT use for single-fact corrections (use kms_supersede directly). Do
  NOT use for hard-deleting flagged entries past the reversibility window — that
  is kms_reap, an admin tool.
version: 1.0
author: richard_yaker
---

# KMS Reconcile Pass — Full Reconciliation Outer Loop

The dedup gate handles **incremental reconciliation** at write-time (Tier 1, ~50ms cost). This skill handles **full reconciliation** — the periodic background pass that drains accumulated dedup debt: contradictions, near-duplicates, orphan supersede chains, and stale facts. Maps directly onto Lewis Liu's agentic-KG framing and OB1 Pattern 1's full-reconciliation half.

The defining rule: **never silently apply corrections**. Always propose with rationale, get user approval, then dispatch.

## Trigger Conditions

Fire on:
- Trigger phrases above
- User requests a weekly/scheduled KMS audit
- Rich says "find contradictions in <topic>" or "clean up <subject>"
- A prior session shipped many writes on one topic and Rich asks to review

Do NOT fire on:
- Single-fact corrections (call `kms_supersede` directly, no skill needed)
- Search-only queries (use `kms-recall`)
- Hard cleanup of flagged entries (use `kms_reap` — admin operation)

## Process

### Step 1: Identify the Reconciliation Scope

Ask the user (or infer):
- **A specific subject** — `Phoenix.camera_count`, `Tengo.business_model`, `Rich.preferences.communication_style`
- **A topic cluster** — "Phoenix" (matches all `Phoenix.*` subjects), "L16", "MyMoneyCoach"
- **A contentType + window** — "all `procedure` entries from the last 30 days"
- **N most-recently-written subjects** — "top 5 high-density subjects from this month"

If unclear, list the candidate clusters and ask Rich to pick:
```
Top candidate clusters for reconciliation:
  1. Phoenix.* (24 entries, 0 supersedes, 3 likely contradictions)
  2. KMSmcp.* (18 entries, 2 supersedes, 5 near-duplicates)
  3. Rich.preferences.* (12 entries, 0 supersedes, looks healthy)
Pick one or specify another.
```

### Step 2: Load the Cluster

Run `unified_search` scoped to the cluster:

```json
{
  "query": "<topic keyword>",
  "filters": {
    "userId": "richard_yaker",
    "subject": "Phoenix.camera_count"
  },
  "options": {
    "maxResults": 50,
    "includeRelationships": true,
    "includeFlagged": true
  }
}
```

`includeFlagged: true` is intentional — reconciliation needs to see superseded/retracted entries to spot orphan chains.

For broader clusters, omit `subject` filter and use a topic query — but tighten with `contentType` if needed.

### Step 3: Read the Cluster, Categorize Each Entry

For each entry returned, place it into one of these buckets:

| Bucket | Definition | Action to propose |
|---|---|---|
| **Canonical** | The current correct fact | None — this is the "winner" |
| **Superseded chain (clean)** | Old entry, properly flagged with `superseded_by` | None — chain is healthy |
| **Superseded chain (orphan)** | New entry exists but old isn't flagged, OR old has `superseded_by` pointing to nothing | Repair: re-run `kms_supersede` or fix the flag |
| **Contradiction** | Two unflagged entries say opposite things about the same subject | Propose `kms_supersede(loser_id, winner_content, reason)` — Rich picks winner |
| **Near-duplicate** | Two entries about the same fact, slightly different phrasing, both unflagged | Propose `kms_update` on the canonical version (merge the better wording in) and `kms_delete` or `kms_supersede` the other |
| **Stale fact** | Was true once, no longer reflects reality | Propose `kms_supersede` with corrected content OR `kms_flag('RETRACTED')` if no replacement |
| **Garbage** | Test entry, accidental store, broken content | Propose `kms_delete(id, reason)` |

### Step 4: Generate the Reconciliation Proposal

Produce a structured proposal — DO NOT call any corrective tool yet. Rich must approve first.

Format:
```
## Reconciliation Proposal: Phoenix.camera_count

Cluster size: 7 entries (5 unflagged, 2 already superseded)

### Proposed actions

1. SUPERSEDE
   Old: abc-123 "Phoenix uses exactly 6 cameras" (2026-03-12)
   New: def-456 "Phoenix camera count is UNKNOWN pending canvas-bounds verification"
   Reason: Canvas bounds unverified per 2026-05-06 review; prior 6-camera claim used wrong zoom config (config 0 not config 2) and A-only FOV.

2. UPDATE
   Entry: ghi-789 "Phoenix camera FOV is 60deg horizontal"
   New content: "Phoenix camera FOV is 60deg horizontal at config 2 (was wrong for config 0)"
   Reason: Add config qualifier; fact is correct but missing context.

3. DELETE
   Entry: jkl-012 "test phoenix entry pls ignore"
   Reason: Test artifact from 2026-02-14, no signal value.

4. NO ACTION (canonical, leave as-is)
   - mno-345 "Phoenix calibration uses 12-point checkerboard at 2m distance"
   - pqr-678 "Phoenix project lead is Jesse as of 2026-04"

### Audit notes
- 1 orphan supersede chain detected (stu-901 has superseded_by=vwx-234, but vwx-234 doesn't exist) — flagging for manual repair
- No contradictions detected after the proposed actions

Approve all / approve specific items / cancel?
```

### Step 5: Wait for Approval — Then Dispatch

Rich's options:
- "approve all" → dispatch every action in order
- "approve 1, 3" → dispatch only those
- "cancel" → no action
- Edits to specific items → revise proposal, re-show, re-confirm

When dispatching, use the corrective tools:
- `kms_supersede(old_id, new_content, reason, contentType, source, metadata)` — atomic supersede (issue #62 fix handles backend probing)
- `kms_update(id, new_content, reason)` — in-place mutation, append reason to `metadata.update_history`
- `kms_delete(id, reason)` — soft-delete, reversible for 90 days
- `kms_flag(id, 'RETRACTED' | 'UNVERIFIED', note)` — partial-wrong flag, original preserved

If using post-PR-#70 dispatch syntax in `unified_store`:
```json
{
  "content": "<new>",
  "action": "supersede",
  "old_id": "abc-123",
  "reason": "<why>",
  "userId": "richard_yaker",
  "metadata": { "subject": "Phoenix.camera_count" }
}
```

### Step 6: Verify and Report

After dispatching, re-run the cluster search to verify:

```
Reconciliation complete for Phoenix.camera_count:
  ✓ 1 supersede applied (abc-123 → def-456)
  ✓ 1 update applied (ghi-789, history bumped)
  ✓ 1 delete applied (jkl-012)
  ⚠ 1 orphan chain still pending manual repair (stu-901 → missing vwx-234)

Cluster now: 4 active entries, 3 superseded (clean chains), 1 orphan flagged for manual review.

Default-search will now return only the corrected version of camera_count.
```

## Why This Skill Exists

The KMS dedup gate spec assumes per-write reconciliation is enough. It isn't. Per the OB1 study at `~/Documents/Notes/OB1-Lessons-vs-KMS-Direction.md`:

> KMS encodes outer-loop policy *inside* the MCP server (dedup, supersede prompts, reaper). Both break the moment the client changes... **Incremental reconciliation** (write-time, cheap) → stays in the server. **Full reconciliation** (background brain-rewiring, expensive) → moves to user-space skills. This is what's currently missing.

This skill IS the missing half. The gate prevents new debt; this skill drains old debt.

## Frequency

Run weekly or on-demand. Don't run after every session — that's over-fitting. The corpus needs accumulated drift before reconciliation finds signal.

Heuristic: if `kms_get_kms_analytics` shows >20 writes since the last reconcile pass for a given subject, it's a candidate.

## What This Skill Does NOT Do

- Does NOT call `kms_reap` — that's a separate admin operation for hard-deleting entries past their 90-day soft-delete window
- Does NOT auto-merge entries silently — every action needs Rich's approval
- Does NOT run on the entire KMS at once — always scoped to a cluster (subject, topic, or contentType filter)
- Does NOT touch entries outside the requested userId — always `userId: richard_yaker`

## Cross-Reference

- Single-fact correction: call `kms_supersede` / `kms_update` / `kms_delete` / `kms_flag` directly, no skill needed
- Search and recall (no corrections): `kms-recall`
- Hard cleanup of flagged entries: `kms_reap` (admin)
- Write-time prevention: dedup gate (Tier 1, automatic on `unified_store`)
