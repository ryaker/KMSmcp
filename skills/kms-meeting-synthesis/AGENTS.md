# KMS Meeting Synthesis (Codex variant)

Codex-flavored protocol for ingesting a meeting transcript / Granola note / Slack huddle / call summary into KMS.

## When this protocol applies

Trigger phrases: "summarize this meeting", "extract action items", "what did we decide", "draft the follow-up", "ingest this Granola", "process this huddle", "log this call", "store these meeting notes". Also fires when handed a Granola URL, Slack canvas URL, or transcript file path with intent to persist.

Do NOT fire on:
- Casual conversation snippets (use `kms-auto-capture`)
- Single-fact stores (use `kms-remember`)
- Reference-only transcripts the user explicitly says are not for KMS

## Process

### Step 1 — Extract meeting metadata

Required: source type (Granola/Slack/Zoom/voice/manual), source URI or null, date (ISO), attendees, topic (one line), duration if available. If any unclear, ASK before proceeding.

### Step 2 — Search KMS for prior related meetings

`unified_search` with topic + primary attendee, `filters.userId: richard_yaker`, `filters.contentType: ["memory"]`. Three outcomes:
- No prior meetings → store as new
- Recurring series → flag prior IDs; new entry will use `action=complement&related_to=<prior>`
- Same-meeting duplicate → STOP, confirm before re-ingesting

### Step 3 — Whole-meeting summary entry

`contentType: memory`, 150-300 words covering: purpose, attendees, decisions, action items, open questions, notable context.

Subject: `Meetings.<YYYY-MM-DD>.<short_topic>` — e.g., `Meetings.2026-05-06.phoenix_calibration_review`.

Capture the returned `id` for use as `related_to` in claim entries.

### Step 4 — 2-5 typed atomic claims

Each linked back via `metadata.related_to: [<meeting_id>]` and given its OWN `metadata.subject` for future supersede-ability.

| Claim type | `contentType` |
|---|---|
| Decision with reasoning | `insight` |
| Project state | `memory` |
| Concrete fact | `fact` |
| Process change | `procedure` |
| Behavioral pattern | `pattern` |

Required claim metadata: `subject` (specific facet like `Phoenix.camera_count`), `related_to` (whole-meeting id array), `source_doc`, `meeting_date`, `captured_via: kms-meeting-synthesis`.

### Step 5 — Handle `dedup_required`

- Same fact, refined → `kms_update`
- Contradicts prior fact → `kms_supersede`
- Distinct facet, follow-up to prior meeting → `unified_store` with `action=complement&related_to=<prior_meeting_id>`
- Genuinely new despite similarity → `unified_store` with `action=force-new&reason=<why>` (use sparingly)

### Step 6 — Report

List: whole-meeting id, atomic claim ids and subjects, supersedes applied, force-new with reasons.

## Quality rules

- Whole-meeting summary 150-300 words. <100 = too thin. >400 = becoming a transcript.
- 2-5 atomic claims per meeting. <2 = not worth ingesting. >5 = transcribing not distilling.
- No "see meeting notes for context" fragments. Each claim survives standalone.
- No verbatim quotes unless the quote IS the fact (e.g., dated commitment).

## Cross-reference

- Cron-batch equivalent: `src/scripts/import-granola.ts` (PR #74) — same contract, runs nightly
- Single-item store: `kms-remember`
- Session-end distillation: `kms-auto-capture`
