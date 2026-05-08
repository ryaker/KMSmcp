---
name: kms-meeting-synthesis
description: >
  Synthesize a meeting transcript, Granola note, Slack huddle recap, call summary,
  or any conversation log into Richard's Personal KMS as one whole-meeting summary
  plus 2-5 typed atomic claims. Triggers on "summarize this meeting", "extract
  action items", "what did we decide", "draft the follow-up", "ingest this
  Granola", "process this huddle", "log this call", "store these meeting notes",
  or when handed a Granola URL / Slack canvas / transcript file in conversation.
  Each claim is self-contained with metadata.related_to pointing back to the
  whole-meeting entry. Routes through unified_store with subject facets and
  handles dedup_required responses with action=complement for related-meeting
  follow-ups. Do NOT use for live chat (use kms-auto-capture). Do NOT bypass the
  dedup gate.
version: 1.0
author: richard_yaker
---

# KMS Meeting Synthesis — Transcript Ingestion Protocol

When the user hands you a meeting/call/huddle transcript (Granola, Slack, voice memo, or manually-pasted notes), distill it into one summary entry + a small set of atomic claim entries linked back to the summary. This is the in-conversation companion to the cron-driven Granola importer (`src/scripts/import-granola.ts`); same contract, agent-driven instead of batch.

## Trigger Conditions

Fire on any of:
- Trigger phrases listed in frontmatter
- User pastes a Granola URL, Slack canvas URL, or `.txt`/`.md` transcript path
- User shares a meeting summary or transcript and asks anything that implies KMS persistence ("save this", "remember this meeting", "log this for the project")
- Granola MCP returns a transcript and user wants it in KMS

Do NOT fire on:
- Casual conversation snippets (use `kms-auto-capture` at session-end)
- Single-fact stores (use `kms-remember`)
- Raw transcripts the user explicitly says are reference-only / not for KMS

## Process

### Step 1: Identify Meeting Metadata

Before any storage, extract:
- **Source**: Granola | Slack huddle | Zoom recording | Voice memo | Manual notes
- **Source URI**: Granola meeting URL, Slack canvas URL, file path, or `null` if pasted text
- **Date**: When the meeting happened (ISO format)
- **Attendees**: Names from transcript (people Rich mentions or speakers)
- **Topic**: One-line characterization ("Phoenix calibration review", "L16 gtm sync")
- **Duration**: If available

If any of these are unclear, ask the user before proceeding. A meeting entry with wrong attendees / wrong date is worse than no entry.

### Step 2: Search KMS for Prior Related Meetings

Run `unified_search` with the meeting topic AND attendees BEFORE storing anything:

```json
{
  "query": "<topic> meeting <primary attendee>",
  "filters": {
    "userId": "richard_yaker",
    "contentType": ["memory"]
  },
  "options": { "maxResults": 8, "includeRelationships": true }
}
```

Three outcomes:
- **No prior meetings on this topic** → store as new (steps 3-5)
- **Recurring meeting series** → flag the prior entry IDs; new whole-meeting entry will use `action=complement&related_to=<prior_id>` if dedup gate refuses
- **Same-meeting duplicate** (someone already ingested this transcript) → STOP. Confirm with user before re-ingesting

### Step 3: Generate the Whole-Meeting Summary

Write a `contentType=memory` entry: 150-300 words covering:
1. **Purpose** — why the meeting happened
2. **Attendees** — named explicitly
3. **Decisions made** — explicit decisions only, not discussion
4. **Action items** — owner + action (use Rich's name when his)
5. **Open questions** — what was deferred / unresolved
6. **Notable context** — anything that frames the decisions (constraints, deadlines mentioned, blockers raised)

This is the "anchor" entry — the typed claims (Step 4) link back to this via `metadata.related_to`.

Subject convention for whole-meeting entries: `Meetings.<YYYY-MM-DD>.<short_topic>` — e.g., `Meetings.2026-05-06.phoenix_calibration_review`.

Store it:
```json
{
  "content": "<150-300 word summary>",
  "contentType": "memory",
  "source": "<personal | technical | coaching | cross_domain>",
  "userId": "richard_yaker",
  "metadata": {
    "subject": "Meetings.2026-05-06.phoenix_calibration_review",
    "source_doc": "<Granola URL | Slack URL | file path | null>",
    "source_type": "granola | slack | zoom | voice_memo | manual",
    "meeting_date": "2026-05-06",
    "attendees": ["Rich", "Jesse", "Kevin"],
    "captured_via": "kms-meeting-synthesis"
  },
  "relationships": []
}
```

**Capture the returned `id` — every claim entry will reference it.**

### Step 4: Extract 2-5 Typed Atomic Claims

From the transcript, pull the 2-5 most load-bearing items that are worth retrieving in isolation. Each MUST be self-contained — readable without the meeting summary or transcript.

Map each to a contentType:
| Claim type | `contentType` | When to use |
|---|---|---|
| Decision with reasoning | `insight` | "Decided to defer L16 launch by 2 weeks because of X" |
| Project state / current status | `memory` | "Phoenix is blocked on canvas-bounds verification as of 2026-05-06" |
| Concrete fact established | `fact` | "Tengo's Q3 revenue is $2.4M; runway 14 months" |
| How-to / process change | `procedure` | "New gate-review process: PR opens issue, reviewer assigns by Friday" |
| Behavioral pattern observed | `pattern` | "Investor calls always run 50% over scheduled time when Kevin attends" |

Each claim entry:
```json
{
  "content": "<self-contained atomic claim, 1-3 sentences>",
  "contentType": "<insight | memory | fact | procedure | pattern>",
  "source": "<inferred from topic>",
  "userId": "richard_yaker",
  "metadata": {
    "subject": "<dotted-path facet — e.g., Phoenix.camera_count>",
    "related_to": ["<whole_meeting_id from step 3>"],
    "source_doc": "<same as whole-meeting>",
    "meeting_date": "2026-05-06",
    "captured_via": "kms-meeting-synthesis"
  }
}
```

**Every claim must have BOTH:**
- `metadata.subject` — the specific facet this claim is about (so future supersedes work)
- `metadata.related_to` — the whole-meeting ID (so a future agent can pull "everything from that meeting")

### Step 5: Handle `dedup_required` for Each Claim

If a claim trips the dedup gate, choose one:

- **Same fact, refined** → `kms_update(old_id, new_content, reason)`
  Example: "Phoenix camera count was UNKNOWN" → "Phoenix camera count is UNKNOWN pending canvas-bounds verification (clarified in 2026-05-06 review)"

- **Contradicts prior fact** → `kms_supersede(old_id, new_content, reason)`
  Example: prior entry says "Phoenix uses 6 cameras"; meeting establishes that number was wrong → supersede

- **Distinct facet of same topic, follow-up to prior meeting** → `unified_store` with `action=complement&related_to=<prior_meeting_id>`
  Example: weekly Phoenix sync — each meeting's claim about Phoenix is complementary, not duplicative

- **Genuinely new despite similarity** → `unified_store` with `action=force-new&reason=<why>`
  Use sparingly. Reason must justify why the gate was wrong.

### Step 6: Report Synthesis Results

```
Synthesized "Phoenix Calibration Review (2026-05-06)" into KMS:

Whole-meeting summary (id: abc-123):
  Subject: Meetings.2026-05-06.phoenix_calibration_review
  Attendees: Rich, Jesse, Kevin
  Source: Granola → https://app.granola.ai/...

Atomic claims:
  1. [insight] Phoenix.calibration_status — calibration deferred 2 weeks
     id: def-456 | related_to: [abc-123]
  2. [fact] Phoenix.camera_count — count is UNKNOWN pending canvas-bounds
     id: ghi-789 | related_to: [abc-123]
     ⚠ SUPERSEDED prior entry jkl-012 ("Phoenix uses 6 cameras")
  3. [procedure] Phoenix.review_cadence — new bi-weekly gate review process
     id: mno-345 | related_to: [abc-123]

3 claims stored | 1 supersede | 0 force-new
```

## Quality Rules

- **Whole-meeting summary**: 150-300 words. Below 100 = too thin to be useful. Above 400 = it's becoming a transcript.
- **Atomic claims**: 2-5 per meeting. Less than 2 = the meeting wasn't worth ingesting. More than 5 = you're not distilling, you're transcribing.
- **No "see meeting notes for context" fragments**. Every claim survives without the meeting entry.
- **No verbatim quotes** unless the quote IS the fact (e.g., "Kevin said 'we'll never ship before October' — date commitment from co-founder").

## Cross-Reference

- Cron-batch equivalent: `src/scripts/import-granola.ts` (PR #74) — same contract, runs nightly
- Single-item store: `kms-remember`
- Session-end distillation: `kms-auto-capture`
- Recall meetings later: `kms-recall` with `metadata.related_to` filter
