# KMS Claude Code Hooks

Drop-in hooks for Claude Code that automate KMS saves during sessions.

## Hooks

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
  "hooks": [{
    "type": "command",
    "command": "/Users/YOU/.claude/hooks/kms-periodic-checkpoint.sh",
    "timeout": 30
  }]
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
          { "type": "command", "command": "~/.claude/hooks/kms-periodic-checkpoint.sh", "timeout": 30 }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/kms-precompact.sh", "timeout": 30 }
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
