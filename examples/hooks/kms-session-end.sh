#!/usr/bin/env bash
# kms-session-end.sh — SessionEnd hook: mine the ending session's transcript into the
# KMS review queue, triaged by Jev (src/scripts/import-claude-session.ts).
#
# SessionEnd hooks cannot block session exit, and share a small time budget with any
# other SessionEnd hooks — ~1.5s by default, raised to at most 60s if a longer `timeout`
# is configured (https://code.claude.com/docs/en/hooks). Mining a transcript is one Jev
# request per candidate turn, which can easily run past that. So this hook does the
# absolute minimum synchronously — parse stdin, launch the importer fully detached, exit
# 0 — and never waits on it, never blocks, and never prints to stdout.
#
# SessionEnd hook JSON on stdin (per the docs above): session_id, transcript_path, cwd,
# scratchpad_dir, permission_mode, hook_event_name, reason ("clear" | "resume" | "logout"
# | "prompt_input_exit" | "other"). This hook only needs transcript_path, cwd, session_id.

set -u

KMS_REPO="${KMS_REPO:-$HOME/Dev/KMSmcp}"
LOG_DIR="$HOME/.kms-session-import"
mkdir -p "$LOG_DIR" 2>/dev/null

INPUT=$(cat)

# Extract transcript_path / cwd / session_id. Never let this hook fail loudly — any
# parse problem just means nothing to mine.
eval $(echo "$INPUT" | python3 -c '
import sys, json, re
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
safe = lambda s: re.sub(r"[^a-zA-Z0-9_/.\-~ ]", "", str(s))
print(f"TRANSCRIPT_PATH=\"{safe(data.get(\"transcript_path\", \"\"))}\"")
print(f"SESSION_CWD=\"{safe(data.get(\"cwd\", \"\"))}\"")
print(f"SESSION_ID=\"{safe(data.get(\"session_id\", \"\"))}\"")
' 2>/dev/null)

TRANSCRIPT_PATH="${TRANSCRIPT_PATH/#\~/$HOME}"
SESSION_CWD="${SESSION_CWD/#\~/$HOME}"

# Nothing to mine, or the importer isn't built — exit clean and silent, immediately.
[ -z "$TRANSCRIPT_PATH" ] && exit 0
[ -f "$TRANSCRIPT_PATH" ] || exit 0

ENTRY="$KMS_REPO/dist/scripts/import-claude-session-cli.js"
[ -f "$ENTRY" ] || exit 0

LOG_FILE="$LOG_DIR/${SESSION_ID:-unknown}.log"

# Jev needs ONECLI_TOKEN / ONECLI_GATEWAY, which Claude Code's hook shell doesn't have.
# Run the importer under a Doppler config (default dev_eng); set
# KMS_SESSION_IMPORT_DOPPLER_CONFIG="" to run it with the hook's own environment.
DOPPLER_CONFIG="${KMS_SESSION_IMPORT_DOPPLER_CONFIG-dev_eng}"
if [ -n "$DOPPLER_CONFIG" ] && command -v doppler >/dev/null 2>&1; then
  RUNNER=(doppler run --project ry-local --config "$DOPPLER_CONFIG" -- node "$ENTRY")
else
  RUNNER=(node "$ENTRY")
fi

# Fully detached: nohup + disown, output to its own log file this process never waits
# on. The session is already exiting — this must not, and cannot, block it.
nohup "${RUNNER[@]}" --transcript "$TRANSCRIPT_PATH" --cwd "$SESSION_CWD" \
  >>"$LOG_FILE" 2>&1 &
disown

exit 0
