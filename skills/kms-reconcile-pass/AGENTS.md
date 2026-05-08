# KMS Reconcile Pass (Codex variant)

Codex-flavored protocol for full-reconciliation passes over KMS topic clusters. **Never silently applies corrections.**

## When this protocol applies

Trigger phrases: "reconcile KMS", "clean up KMS", "audit KMS for <topic>", "weekly KMS pass", "find contradictions in KMS", "drain KMS dedup debt", "reconcile <topic>".

Do NOT fire on:
- Single-fact corrections — call `kms_supersede` directly, no skill needed
- Pure search queries — use `kms-recall`
- Hard cleanup of flagged entries — that's `kms_reap`, an admin tool

## Defining rule

Never silently apply corrections. Every supersede/update/delete needs explicit user approval before dispatch.

## Process

### Step 1 — Identify scope

Ask user (or infer): a specific subject (`Phoenix.camera_count`), a topic cluster (`Phoenix`), a contentType+window, or N most-recently-written subjects. If unclear, present candidate clusters and let Rich pick.

### Step 2 — Load the cluster

```
unified_search:
  query: <topic keyword>
  filters:
    userId: richard_yaker
    subject: <if specific subject>
  options:
    maxResults: 50
    includeRelationships: true
    includeFlagged: true
```

`includeFlagged: true` is intentional — reconciliation needs to see superseded entries to spot orphan chains.

### Step 3 — Categorize each entry

| Bucket | Action to propose |
|---|---|
| Canonical (current correct fact) | None |
| Superseded chain (clean) | None |
| Superseded chain (orphan) — old not flagged or `superseded_by` points to nothing | Repair: re-run `kms_supersede` or fix the flag |
| Contradiction (two unflagged entries say opposite things on same subject) | `kms_supersede(loser_id, winner_content, reason)` — Rich picks winner |
| Near-duplicate (same fact, slightly different phrasing) | `kms_update` on canonical + `kms_delete`/`kms_supersede` the other |
| Stale fact (was true, no longer reflects reality) | `kms_supersede` with corrected content OR `kms_flag('RETRACTED')` if no replacement |
| Garbage (test entry, accidental store) | `kms_delete(id, reason)` |

### Step 4 — Generate proposal

Structured output: numbered list of proposed actions, each with old/new content (where applicable) and a reason. DO NOT call any corrective tool yet. Audit notes for orphan chains. End with "Approve all / approve specific items / cancel?"

### Step 5 — Wait for approval, then dispatch

Approved actions use:
- `kms_supersede(old_id, new_content, reason, contentType, source, metadata)` — atomic, handles backend probing per issue #62 fix
- `kms_update(id, new_content, reason)` — appends reason to `metadata.update_history`
- `kms_delete(id, reason)` — soft-delete, reversible 90 days
- `kms_flag(id, 'RETRACTED' | 'UNVERIFIED', note)` — partial-wrong without replacement

Or, with post-PR-#70 dispatch syntax:
```
unified_store:
  content: <new>
  action: supersede
  old_id: <abc-123>
  reason: <why>
  userId: richard_yaker
  metadata: { subject: <facet> }
```

### Step 6 — Verify and report

Re-run cluster search. Report counts: supersedes applied, updates applied, deletes applied, orphan chains pending manual repair. Confirm default-search now returns corrected versions only.

## Frequency

Weekly or on-demand. Don't run after every session. Heuristic: >20 writes since last reconcile pass for a subject = candidate.

## What this protocol does NOT do

- Does NOT call `kms_reap` (separate admin operation for hard-deleting past 90-day window)
- Does NOT auto-merge entries silently — every action needs Rich's approval
- Does NOT run on entire KMS at once — always cluster-scoped
- Does NOT touch `userId != richard_yaker`

## Cross-reference

- Single-fact correction: call `kms_supersede` directly
- Search-only: `kms-recall`
- Hard cleanup: `kms_reap` (admin)
- Write-time prevention: dedup gate (automatic on `unified_store`)
