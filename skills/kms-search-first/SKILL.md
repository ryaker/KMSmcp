---
name: kms-search-first
description: >
  Search Richard's Personal KMS BEFORE answering from training data or generating
  net-new content, whenever the user references prior conversation, prior decisions,
  prior facts, or prior preferences. Triggers on "remember when", "we discussed",
  "I previously said", "did I store", "what did I decide about", "didn't we talk
  about", "I think I told you", "have I mentioned", "we worked on this before",
  "what's my preference for", "did I already note", or any reference to prior
  context that would require KMS retrieval to answer accurately. Calls
  unified_search FIRST, surfaces results, THEN proceeds with whatever the user
  actually wanted (extending, retrieving, or storing). Behavioral inversion:
  search BEFORE generation, not as a fallback. Do NOT use as a replacement for
  kms-recall in pure-retrieval queries — kms-recall is search-and-present;
  kms-search-first is search-then-act.
version: 1.0
author: richard_yaker
---

# KMS Search-First — The Mandatory Pre-Generation Reflex

When the user references prior conversation, prior decisions, prior preferences, or anything that implies KMS-stored context, **call `unified_search` BEFORE generating an answer**. This is the codification of the "search first, store smart" rule from CLAUDE.md as a portable behavioral skill.

The behavioral shift this enforces: **search is the FIRST action, not a fallback when training data fails.**

## Trigger Conditions

Fire on:
- Trigger phrases listed in frontmatter
- User makes ANY claim of the form "I [previously / earlier / before] [said / decided / stored / mentioned / noted] X"
- User asks a factual question about themselves, their projects, their preferences ("what's my X?", "how do I usually Y?")
- User asks about a project, person, or technical decision they likely have prior context on
- You're about to generate a confident-sounding answer about Rich's preferences/projects/people from training data

That last one is the critical case. If you find yourself confidently generating a Rich-specific answer without checking, that's the trigger. Stop and search.

Do NOT fire on:
- Pure-recall queries with no follow-up action ("what do I know about X?") — use `kms-recall` instead
- Generic factual questions unrelated to Rich's personal context ("what's the syntax for jq?")
- Real-time data ("what time is it?")

## Process

### Step 1: Search

```json
{
  "query": "<the topic the user referenced>",
  "filters": { "userId": "richard_yaker" },
  "options": {
    "maxResults": 10,
    "includeRelationships": true
  }
}
```

Tighten with filters when you have signal:
- Topic-specific subject: add `filters.subject: "Phoenix.camera_count"` (exact facet)
- Domain known: add `filters.source: ["technical"]` or `["personal"]`
- Confidence floor: `filters.minConfidence: 0.6`

### Step 2: Surface Results to the User

Don't silently absorb the results into the next answer. **Show what you found**, briefly:

```
Searched KMS for "Phoenix camera count":
  • [fact, 88%] Phoenix.camera_count — UNKNOWN pending canvas-bounds verification
    (superseded earlier 6-camera claim; reason: wrong zoom config + A-only FOV)
  • [insight, 79%] Phoenix.calibration_status — calibration deferred 2 weeks per 2026-05-06 review

Continuing with your question:
```

This serves three purposes:
1. **Transparency** — Rich sees what context informed the next answer
2. **Correction opportunity** — if the search missed something or surfaced a stale entry, Rich can redirect
3. **Trust calibration** — Rich knows the answer is grounded in stored context, not hallucination

### Step 3: Proceed With What Rich Actually Wanted

The search is the FIRST step, not the WHOLE step. After surfacing results:

- If user asked a question → answer it using the search hits as ground truth
- If user wants to extend a prior fact → use `kms_update` or `kms_supersede` (NEVER additively `unified_store`)
- If user wants to retrieve only → you're done; this is the `kms-recall` path
- If user wants to store something new related to the prior context → `unified_store` with `metadata.subject` matching the prior entry's subject so they're queryable as a cluster

### Step 4: Handle "No Results"

If search returns empty or low-confidence (<0.5) hits:
1. Say so explicitly: "I don't have anything stored about [topic] in your KMS."
2. Offer alternatives:
   - "Want me to search for related terms? I might have something filed under [adjacent concept]."
   - "Want me to add what we discuss now to KMS as a new entry?"
3. Do NOT silently fall back to training data and answer as if you had context. Be honest about the gap.

## Why This Skill Exists

KMS adoption is bottlenecked by **read failures**, not write failures. The corpus has 200+ entries; most never get retrieved because the agent doesn't think to search. Every confident-from-training answer about Rich's preferences/projects is a missed read — and a slow erosion of trust in the KMS as a source.

This skill makes search-first into muscle memory. The cost of an unnecessary search is ~50ms; the cost of a confidently-wrong answer that contradicts stored context is much higher.

## What This Skill Does NOT Do

- Does NOT replace `kms-recall` for pure-retrieval queries — that skill is search-and-present, this one is search-then-act
- Does NOT replace `kms-grounding` for full-context briefings — that skill synthesizes; this one is a reflex
- Does NOT call any storage tools — only `unified_search`. Storage decisions happen in the follow-on step using the skill that fits (`kms-remember`, `kms-auto-capture`, `kms-meeting-synthesis`)
- Does NOT search for things unrelated to Rich's context — generic web-knowledge questions don't trigger this

## Cross-Reference

- Pure search-and-present: `kms-recall`
- Full briefing on a topic: `kms-grounding`
- Single-item store after search: `kms-remember`
- Session-end batched store: `kms-auto-capture`
- Correct a prior wrong fact found in search: `kms_supersede` (direct tool call, not a skill)
