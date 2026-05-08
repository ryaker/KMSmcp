# KMS Auto-Capture (Codex variant)

This file is the AGENTS.md flavor of the `kms-auto-capture` skill — same protocol, Codex-friendly format. Codex reads the closest `AGENTS.md` in the directory tree.

## When this protocol applies

When you (the agent) detect a session-end cue from the user — "wrap up", "park this", "let's stop here", "call it", "we're done for today", "goodnight", "sign off", "checkpoint", "save state", "before I forget" — distill the working session into atomic, self-contained KMS entries via `unified_store`. Also fires when a multi-turn working session reaches a natural close.

Do NOT fire on single-question Q&A or sessions where nothing of lasting value was established.

## Core rule: distilled claims, not transcripts

Every stored item must read correctly **without the original conversation context**. If a future agent retrieves it cold, it must still be a complete thought.

- BAD: "We talked about that issue I mentioned earlier with Phoenix calibration."
- GOOD: "Phoenix camera count is unverified pending canvas-bounds check; prior 6-camera claim used wrong zoom config."

## Process

1. Identify capture candidates — items that are novel, atomic, and self-contained.
2. For each candidate, run `unified_search` with `userId: richard_yaker` BEFORE storing.
3. If a near-duplicate exists, choose: skip (rephrase only) / `kms_update` (refinement) / `kms_supersede` (contradiction).
4. Pick a `metadata.subject` (REQUIRED) — dotted-path facet like `Phoenix.camera_count`, `Rich.preferences.communication_style`, `KMSmcp.dedup_gate_status`.
5. Store via `unified_store` with `userId: richard_yaker`, `metadata.subject`, `metadata.captured_via: "kms-auto-capture"`.
6. Handle `dedup_required` responses with explicit retry actions (`supersede`, `update`, `complement`, `force-new`) — never re-attempt the original write blindly.
7. Report: list captured items, skipped duplicates, supersedes applied.

## ContentType mapping

| Item type | `contentType` |
|---|---|
| Decision with reasoning | `insight` |
| Preference | `memory` |
| Learning / aha | `insight` |
| Project state | `memory` |
| Brainstorm worth keeping | `insight` |
| Reference fact | `fact` |
| How-to / procedure | `procedure` |

## Quality bar

- 3-8 entries from a substantive session is healthy. 20+ = transcribing, not distilling. 0 = honest report that the session had nothing worth keeping.
- NEVER store entries like "User asked X, I responded Y" or "Long discussion about Z — see session for details".

## Required `unified_store` fields

```
content: <atomic claim, 1-3 sentences>
contentType: <insight | memory | fact | procedure | pattern | relationship>
source: <personal | technical | coaching | cross_domain>
userId: richard_yaker
metadata:
  subject: <Project.fact_name or Person.preferences.facet>
  captured_via: kms-auto-capture
  session_date: <ISO date>
```

## Cross-reference

- Single-item store: `kms-remember`
- Meeting transcripts: `kms-meeting-synthesis`
- Weekly cleanup: `kms-reconcile-pass`
- Pre-store recall: `kms-search-first`
- Trust boundaries (Lumen/L16): `kms-trust-boundaries`
