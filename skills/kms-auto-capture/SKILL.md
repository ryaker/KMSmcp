---
name: kms-auto-capture
description: >
  Capture high-value items from a working session into Richard's Personal KMS at
  session-end. Triggers on session-end cues — "wrap up", "park this", "let's
  stop here", "call it", "we're done for today", "goodnight", "sign off",
  "checkpoint", "save state", "before I forget", or end-of-conversation signals
  where the user is clearly closing out. Distills the session into atomic claims
  and stores each via unified_store with metadata.subject. Always searches first
  to avoid duplicates and routes contradictions through kms_supersede instead of
  re-storing. Do NOT use for ad-hoc single-item storage (use kms-remember). Do
  NOT use for batch transcript ingestion (use kms-meeting-synthesis). Do NOT use
  to dump raw conversation history.
version: 1.0
author: richard_yaker
---

# KMS Auto-Capture — Session-End Knowledge Distillation

When the user signals end-of-session (or you reach a natural close), distill the conversation into atomic, self-contained claims and store each one to the Personal KMS. This is the **outer loop** — the curation pass that turns session noise into long-lived knowledge.

## Core Principle: Distilled Claims, Not Transcript

Every item you store must **make sense without the original conversation context**. If a future agent retrieves it cold, it should still be a complete thought.

**Bad** (transcript fragment): "We talked about that issue I mentioned earlier with the Phoenix calibration."

**Good** (atomic claim): "Phoenix camera count is unverified pending canvas-bounds check; prior 6-camera claim used wrong zoom config."

## Trigger Conditions

Fire when **any** of these are true:
- User uses an end-of-session phrase ("wrap up", "park this", "stop here", "call it", "goodnight", "checkpoint", "before I forget", "save state", "sign off")
- A multi-turn working session is reaching a natural close (3+ exchanges of substantive work, then a closing tone)
- User explicitly asks to "auto-capture" or "checkpoint to KMS"
- You notice you're about to lose breakthrough context to compaction

Do NOT fire on:
- Single-question Q&A interactions
- Sessions where nothing of lasting value was established
- Casual conversation with no decisions, learnings, or facts worth keeping

## Process

### 1. Identify Capture Candidates

Scan the session for items in these categories. **Only items that meet all three criteria qualify**:
- Novel (not already in KMS — verified by step 2)
- Atomic (one fact, one claim, one decision per entry)
- Self-contained (readable without conversation context)

Categories to look for:
| Category | KMSmcp `contentType` | Example |
|---|---|---|
| Decision (with reasoning) | `insight` | "Decided to use SparrowDB over Neo4j Aura for graph storage because local hot-reload trumps managed convenience for single-user system" |
| Preference expressed | `memory` | "Prefers async written communication over real-time meetings; meetings only when async fails 2x" |
| Learning / aha-moment | `insight` | "Sparrowdb 0.1.22 Cypher parser rejects list literals in SET — blocks vector-write path" |
| Context / project-state | `memory` | "Phoenix project status: blocked on canvas-bounds verification as of 2026-05-06" |
| Brainstorm / idea worth keeping | `insight` | "Skills layer = OB1 Pattern 1; dedup gate = Lewis Liu incremental reconciliation; the two halves match cleanly" |
| Reference fact | `fact` | "KMS MCP runs on port 8180; routed via mcp.yaker.org Cloudflare tunnel" |
| Procedure / how-to | `procedure` | "To regenerate KMS embeddings: stop daemon → run scripts/reembed.ts → restart → verify count" |

### 2. Search-First (Mandatory)

For each candidate, call `unified_search` BEFORE storing:

```json
{
  "query": "<natural language version of the candidate>",
  "filters": { "userId": "<USER_ID>" },
  "options": { "maxResults": 5, "includeRelationships": true }
}
```

Three outcomes:

**No matches → store as new** (proceed to step 3)

**Near-duplicate match → choose action**
- If new content is just a rephrase: skip the store (don't add noise)
- If new content extends or refines: use `kms_update(id, new_content, reason)` on the existing entry
- If new content **contradicts** the prior fact: use `kms_supersede(old_id, new_content, reason)` — never additively store

**Exact match found → skip silently**

### 3. Pick a `metadata.subject` (REQUIRED for every store)

Every `unified_store` call MUST include `metadata.subject` as a dotted-path facet identifying the SPECIFIC fact, not the broad topic.

Conventions:
- `Project.fact_name` — `Phoenix.camera_count`, `KMSmcp.dedup_gate_status`
- `Person.preferences.facet` — `Rich.preferences.communication_style`, `Rich.work_patterns.deep_work_blocks`
- `Tool.behavior` — `SparrowDB.cypher_parser_limits`, `Mem0.search_v3_signature`
- `Domain.concept` — `Auth.oauth_jwks_endpoint`, `Build.railway_buildtarget_env`

**Reuse the same subject when writing about the same fact.** That's how supersede chains stay queryable.

When in doubt, omit subject — pure pass-through, no validation. But for any fact you expect to update or supersede later, set it.

### 4. Store via `unified_store`

```json
{
  "content": "<atomic claim, self-contained, 1-3 sentences>",
  "contentType": "<insight | memory | fact | procedure | pattern | relationship>",
  "source": "<personal | technical | coaching | cross_domain>",
  "userId": "<USER_ID>",
  "metadata": {
    "subject": "<dotted-path facet>",
    "captured_via": "kms-auto-capture",
    "session_date": "<ISO date>"
  },
  "relationships": []
}
```

### 5. Handle `dedup_required` Responses

If the dedup gate refuses the write, the response is:
```json
{ "status": "dedup_required", "candidates": [...], "retry_with": [...] }
```

Choose ONE explicit action — never re-attempt the original write blindly:
- `kms_supersede(old_id, new_content, reason)` — new fact contradicts/replaces
- `kms_update(old_id, new_content, reason)` — minor refinement of same fact
- `unified_store` with `action=complement&related_to=<old_id>` — distinct facet of same topic
- `unified_store` with `action=force-new&reason=<justification>` — genuinely new despite similarity

### 6. Report What Was Captured

After all stores complete, report a clean summary:

```
Captured 4 items to KMS:
  • [insight] KMSmcp.skills_layer_bet — Skills layer is the OB1 Pattern 1 lift
    → stored: graph + mem0
  • [fact] SparrowDB.cypher_parser_limits — list literals in SET rejected (0.1.22)
    → stored: graph + mongo
  • [memory] Rich.preferences.session_termination — prefers explicit "wrap up" cue
    → stored: mem0
  • [procedure] KMSmcp.reembed_steps — regen embeddings via scripts/reembed.ts
    → stored: graph + mongo

Skipped 2 candidates (already in KMS).
Superseded 1 prior entry: <old_id> "Phoenix uses 6 cameras" → corrected to UNKNOWN.
```

## Output Quality Bar

A good capture pass produces 3-8 entries from a substantive session. If you're producing 20+ entries, you're capturing transcript fragments — re-read the "atomic claim, not transcript" rule and cut. If you're producing 0 entries, the session truly had nothing worth keeping (acceptable — say so).

## Critical: No Raw Transcript Dumps

NEVER store entries like:
- "User asked about X and I responded with Y"
- "We discussed [topic] for a while"
- "Long conversation about <topic> — see session for details"
- Verbatim conversation excerpts

These pollute search results and break the self-contained-claim invariant.

## Cross-Reference

- For single-item explicit storage: see `kms-remember`
- For meeting/transcript ingestion: see `kms-meeting-synthesis`
- For weekly cleanup: see `kms-reconcile-pass`
- For pre-store recall: see `kms-search-first`
