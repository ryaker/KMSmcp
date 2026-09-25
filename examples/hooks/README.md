# KMS Claude Code Hooks

Drop-in hooks for Claude Code that automate KMS saves during sessions.

## Hooks

### `kms-context-inject.sh` + `kms_context_format.py` — UserPromptSubmit hook

Fires on every prompt. Picks the KMS server from the working directory (`~/Dev` →
eng-kms, otherwise personal), runs `unified_search`, and injects the results as
`additionalContext`, capped at 2,000 chars for the whole block.

**Trust framing.** Injected memories are past data, sometimes quoting external text.
They are not instructions. `kms_context_format.py` wraps them in a boundary:

- Open and close markers share a random nonce per call:
  `[ENG-KMS Memory Context #1a2b3c4d]` … `[End ENG-KMS Context #1a2b3c4d]`.
  A stored memory can't forge the close marker because it can't know the nonce.
- A short note after the open marker says the block is background evidence with no
  authority over instructions, permissions, or the user's request.
- Marker text inside a memory (`[End KMS Context`, `[End ENG-KMS Context`, any label)
  is replaced with `[marker-text-removed]`. Look-alikes that only match after Unicode
  folding are logged to stderr, not altered.
- The wrapper counts against the budget.

**Install:**

```bash
cp kms-context-inject.sh kms_context_format.py ~/.claude/hooks/
chmod +x ~/.claude/hooks/kms-context-inject.sh
```

```json
"UserPromptSubmit": [{
  "hooks": [{ "type": "command", "command": "/Users/YOU/.claude/hooks/kms-context-inject.sh" }]
}]
```

**Test (no network):** `python3 examples/hooks/test_kms_context_format.py -v`

---

### `kms-precompact.sh` — PreCompact hook

Fires **right before** Claude Code compresses the conversation to free context window space.
Always blocks and tells Claude to save everything to KMS first.
Compaction is lossy — this is the safety net.

**Install:**

```bash
cp kms-precompact.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/kms-precompact.sh
```

Add to `~/.claude/settings.json`:

```json
"PreCompact": [{
  "hooks": [{
    "type": "command",
    "command": "/Users/YOU/.claude/hooks/kms-precompact.sh",
    "timeout": 30
  }]
}]
```

---

### `kms-periodic-checkpoint.sh` — Stop hook (periodic)

Fires on every session stop, but only **blocks every N human exchanges** (default: 20).
When it blocks, tells Claude to do a structured KMS save with full conversational context.

This complements per-turn silent extraction (`kms-session-extract.py`) — it fires less
often but asks Claude itself to save, capturing reasoning and relationships that regex
patterns miss.

Uses `stop_hook_active` guard to prevent infinite loops: block once → Claude saves →
tries to stop again → hook lets it through.

**Install:**

```bash
cp kms-periodic-checkpoint.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/kms-periodic-checkpoint.sh
mkdir -p ~/.claude/hooks/kms-watermarks  # state dir
```

Add to `~/.claude/settings.json` Stop section:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "/Users/YOU/.claude/hooks/kms-periodic-checkpoint.sh",
      "timeout": 30
    }
  ]
}
```

**Tune the interval** by editing `SAVE_INTERVAL=20` at the top of the script.

**Logs:** `/tmp/kms-checkpoint-debug.log`

---

## Recommended settings.json layout

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/kms-periodic-checkpoint.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/kms-precompact.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Inspiration

Pattern adapted from [MemPalace](https://github.com/milla-jovovich/mempalace) — the highest-scoring
AI memory system on LongMemEval (96.6%). Their key insight: periodic blocking saves with Claude
doing the classification outperforms regex extraction because Claude has the full conversational
context to decide what matters.

---

### `kms-session-end.sh` — SessionEnd hook

Fires when a session ends. Extracts `transcript_path` / `cwd` / `session_id` from the hook JSON
and launches `src/scripts/import-claude-session-cli.ts` (built:
`dist/scripts/import-claude-session-cli.js` — the thin CLI wrapper around the import-only
`import-claude-session.ts`) fully detached — `nohup` + `disown`, no stdout, exits 0 immediately.

**Why detached.** SessionEnd hooks cannot block session exit, and share a small time budget with
any other SessionEnd hooks (~1.5s by default, raised to at most 60s if a longer `timeout` is
configured — see the [hooks docs](https://code.claude.com/docs/en/hooks)). Mining a transcript is
one Jev request per candidate turn, which routinely runs past that budget, so the hook itself does
nothing but parse stdin and launch the importer in the background.

**What the importer does** (see `src/scripts/import-claude-session.ts` for the full design):
parses the session's JSONL transcript into candidate turn units (skipping tool results, system
reminders, hook-injected KMS recall context, subagent turns, and anything under 40 chars), has Jev
triage each one with small atomic nouls (`durable_preference_or_correction`, `decision_with_reason`,
`verified_fact_or_fix`, `ephemeral`, `mentions_sophia`), hard-drops anything Sophia-related (the
MyMoneyCoach.ai persona — HARD RULE, never eng_kms or personal_kms), ranks the rest, and writes the
top few to the KMS review queue (`unified_store` with `review: "candidate"`) — held for
`kms_review approve` rather than injected live. Routes eng_kms vs personal_kms from `cwd`, mirroring
`kms-context-inject.sh`'s `is_eng_cwd`. A per-session watermark
(`~/.kms-session-import/<session_id>.json`) makes re-runs (e.g. a resumed session ending again)
idempotent — already-considered transcript lines are never re-classified.

**Install:**

```bash
cp kms-session-end.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/kms-session-end.sh
```

```json
"SessionEnd": [{
  "hooks": [{ "type": "command", "command": "/Users/YOU/.claude/hooks/kms-session-end.sh" }]
}]
```

**Environment:**

| Variable | Purpose |
|---|---|
| `KMS_REPO` | Where the built importer lives. Default `~/Dev/KMSmcp`. |
| `KMS_SESSION_IMPORT_DOPPLER_CONFIG` | Optional Doppler config (e.g. `dev_eng`) to wrap the importer in, so it inherits `ONECLI_TOKEN`/`ONECLI_GATEWAY` for Jev even when the hook's own shell doesn't have them. Unset by default. |

**Logs:** `~/.kms-session-import/<session_id>.log` (importer stdout/stderr — the hook itself never
prints anything, by design).

**Test (no network, no KMS writes):**

```bash
npx tsx src/scripts/import-claude-session.ts \
  --transcript ~/.claude/projects/<slug>/<session>.jsonl \
  --cwd ~/Dev/KMSmcp --dry-run
```
