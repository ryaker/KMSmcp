---
name: kms-session-checkpoint
description: >
  Saves structured session knowledge to the Personal KMS (unified_store) — decisions,
  technical facts, correction patterns, and working procedures discovered during the
  session. Use whenever the user says "save this session", "checkpoint the session",
  "save what we learned", "save to KMS before I stop", "dump session insights",
  "capture what we figured out", "session checkpoint", or "kms checkpoint". Also
  fires automatically when a PreCompact or periodic Stop hook blocks with a
  KMS CHECKPOINT reason. Do NOT use for searching or recalling from KMS (that is
  kms-recall). Do NOT use for storing a single ad-hoc fact — call unified_store
  directly. Do NOT use for silent per-turn extraction — kms-session-extract.py
  handles that automatically.
---

## Overview

This skill reviews the current session and writes every item worth keeping into
the Personal KMS via `unified_store`. It runs when the user explicitly asks for a
checkpoint, or when a blocking hook (PreCompact, periodic Stop) tells Claude to
save before the session ends or context compresses. The output is one or more
`unified_store` MCP calls with the correct `contentType`, `source`, `userId`, and
relationship links — not prose, not a summary for the user.

## Workflow

1. Scan the session transcript (from first user message to now) and list every
   candidate item that falls into one of these four categories:
   - **Decision + why** → `contentType: insight`
   - **Technical fact learned** (bug root cause, config, command, path) → `contentType: fact`
   - **Correction or preference the user gave** → `contentType: pattern` (verbatim quote preferred)
   - **Procedure that worked** (sequence of steps that solved a problem) → `contentType: procedure`

2. Drop any item that matches ANY of these filters:
   - Line numbers, temporary paths, ephemeral debug output
   - Items already explicitly saved this session
   - Restating what is already in CLAUDE.md, rules/, or known skills
   - Items under 40 characters (too thin to be useful)
   - Pure acknowledgements ("thanks", "got it", "ok")

3. For each surviving item, construct the `unified_store` arguments:
   - `content`: the knowledge in one or two sentences, verbatim where the item is a user correction
   - `contentType`: one of `insight | fact | pattern | procedure`
   - `source`: `technical` for code/config/bugs, `personal` for preferences/corrections
   - `userId`: `richard_yaker` (always — this is Rich's personal KMS)
   - `confidence`: 0.85 for facts and procedures, 0.90 for verbatim corrections, 0.80 for insights
   - `relationships`: include when the item links to a known project, person, or concept

4. Call `mcp__claude_ai_PersonalKMS__unified_store` once per item. Do NOT batch into
   a single call — relationships and contentType must be per-item.

5. After all calls return, output ONE line to the user: `Saved N items to KMS
   (breakdown: X insight, Y fact, Z pattern, W procedure).` Do NOT summarize what
   was saved — the user can query KMS for that.

## Output Format

Claude's visible output is ONLY the final confirmation line. Everything else is
tool calls to `unified_store`. The confirmation line format is exactly:

```
Saved <N> items to KMS (breakdown: <counts>).
```

Do NOT output:
- A recap of the items saved
- A "here is what I stored" list
- Commentary about the session
- Suggestions for what to do next

## Relationship guidance

Add a `relationships` array when the item clearly connects to a known entity.
Common patterns:

| Situation | Relationship |
|-----------|-------------|
| Architecture choice within a project | `PART_OF` the project |
| Bug fix | `FIXES` the bug or error |
| Pattern that applies to a workflow | `APPLIES_TO` the workflow |
| Decision replacing a previous approach | `SUPERSEDES` the old one |
| Fact about a dependency or tool | `RELATES_TO` the tool |

Each relationship needs: `targetId` (slug of the entity), `type` (the verb above),
and `strength` (0.70–0.95 based on how central the link is).

## Examples

### Example 1 — Happy path

**Session context:** User debugged a Neo4j connection bug, chose to use the
SparrowDB npm package over local builds, and corrected Claude for suggesting
a hack fix instead of the root cause.

**Expected tool calls:**

Call 1 (fact, technical):
```json
{
  "content": "Neo4j connection failed when NEO4J_URI used bolt+s:// with a self-signed cert — root cause was missing trustStrategy: TRUST_ALL_CERTIFICATES in driver config",
  "contentType": "fact",
  "source": "technical",
  "userId": "richard_yaker",
  "confidence": 0.85,
  "relationships": [{"targetId": "Neo4jStorage", "type": "RELATES_TO", "strength": 0.9}]
}
```

Call 2 (insight, technical):
```json
{
  "content": "Chose SparrowDB npm package over local Rust build for KMSmcp — makes the module portable without a Rust toolchain, fallback path kept for dev builds",
  "contentType": "insight",
  "source": "technical",
  "userId": "richard_yaker",
  "confidence": 0.80,
  "relationships": [{"targetId": "KMSmcp", "type": "PART_OF", "strength": 0.9}]
}
```

Call 3 (pattern, personal — verbatim):
```json
{
  "content": "Rich: 'Don't patch around it — fix the root cause. A hack is not a fix.'",
  "contentType": "pattern",
  "source": "personal",
  "userId": "richard_yaker",
  "confidence": 0.90
}
```

**Final visible output:**
```
Saved 3 items to KMS (breakdown: 1 insight, 1 fact, 1 pattern, 0 procedure).
```

### Example 2 — Edge case: nothing worth saving

**Session context:** User asked three short questions about file locations, Claude
answered from existing CLAUDE.md content, no decisions made, no bugs found, no
corrections given.

**Expected behavior:** Make zero `unified_store` calls. Output:
```
Saved 0 items to KMS — no novel content this session.
```

Do NOT invent items to store. An empty checkpoint is a valid outcome.

### Example 3 — Edge case: user correction without context

**Session context:** User said "stop doing that" without specifying what, and
Claude is unsure which behavior was being corrected.

**Expected behavior:** Do NOT store a vague pattern like "user said stop". Ask
the user one clarifying question: "Which behavior should I save as a rule —
[specific thing A] or [specific thing B]?" Once clarified, store the verbatim
correction with full context. If the user declines to clarify, skip it.

## Quality checklist (run before finishing)

Before confirming, verify:
- [ ] Every stored item has `userId: richard_yaker`
- [ ] Every `contentType` is one of the four valid values
- [ ] No item duplicates something already in KMS from earlier this session
- [ ] Verbatim quotes were used for any `pattern` from a user correction
- [ ] Final output is exactly the confirmation line format — no recap
