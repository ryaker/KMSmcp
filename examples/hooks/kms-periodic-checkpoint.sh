#!/bin/bash
# kms-periodic-checkpoint.sh — Periodic blocking KMS save
#
# Stop hook. Every SAVE_INTERVAL human messages, blocks and tells Claude
# to do a structured KMS save with full conversational context.
#
# Phase 0 eng-kms: cwd under /Volumes/Dev or ~/Dev routes to eng-kms
# (userId=eng_kms, MCP eng-kms / localhost:8181). Personal cwd keeps
# writing to personal KMS. Never wipe/migrate personal data here.

SAVE_INTERVAL=50
STATE_DIR="$HOME/.claude/hooks/kms-watermarks"
LOG=/tmp/kms-checkpoint-debug.log

INPUT=$(cat)

# Parse session_id, stop_hook_active, transcript_path, cwd
eval $(echo "$INPUT" | python3 -c "
import sys, json, re, os
data = json.load(sys.stdin)
sid   = data.get('session_id', 'unknown')
sha   = data.get('stop_hook_active', False)
tp    = data.get('transcript_path', '')
cwd   = data.get('cwd') or data.get('working_directory') or data.get('cwd_path') or ''
# some payloads nest cwd
if not cwd and isinstance(data.get('session'), dict):
    cwd = data['session'].get('cwd') or ''
safe  = lambda s: re.sub(r'[^a-zA-Z0-9_/.\-~ ]', '', str(s))
print(f'SESSION_ID=\"{safe(sid)}\"')
print(f'STOP_HOOK_ACTIVE=\"{sha}\"')
print(f'TRANSCRIPT_PATH=\"{safe(tp)}\"')
print(f'CWD=\"{safe(cwd)}\"')
" 2>/dev/null)

# Expand ~ in path
TRANSCRIPT_PATH="${TRANSCRIPT_PATH/#\~/$HOME}"
CWD="${CWD/#\~/$HOME}"

# If cwd missing, try transcript path heuristic (projects/-Volumes-Dev-...)
if [ -z "$CWD" ] && [ -n "$TRANSCRIPT_PATH" ]; then
  case "$TRANSCRIPT_PATH" in
    */.claude/projects/-Volumes-Dev-*) CWD="/Volumes/Dev" ;;
    */.claude/projects/-Users-ryaker-Dev-*) CWD="$HOME/Dev" ;;
  esac
fi

is_eng_cwd() {
  local p="$1"
  case "$p" in
    /Volumes/Dev|/Volumes/Dev/*) return 0 ;;
    "$HOME/Dev"|"$HOME/Dev"/*) return 0 ;;
    /Users/ryaker/Dev|/Users/ryaker/Dev/*) return 0 ;;
    *) return 1 ;;
  esac
}

venture_from_cwd() {
  local p="$1"
  case "$p" in
    *[Bb]lock[Cc]opy*|*/DittoTrade*|*/bc26*) echo blockcopy ;;
    *[Ss]parrow*) echo sparrow ;;
    *[Tt]engo*|*/Zinnia*) echo tengo ;;
    */L16*|*/Light_*|*/Phoenix*|*/lumen*) echo l16 ;;
    */KMSmcp*|*/mcp-gateway*) echo kms ;;
    */agent-bus*|*/claude-ops*|*/claude-intelligence*) echo infra ;;
    */abundance*|*/coaching-clone*|*/sophia*) echo coaching ;;
    *) echo eng ;;
  esac
}

# Already in a save cycle — let Claude stop normally
if [ "$STOP_HOOK_ACTIVE" = "True" ] || [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    echo "{}"
    exit 0
fi

# Count human messages in JSONL (skip command-message turns)
if [ -f "$TRANSCRIPT_PATH" ]; then
    EXCHANGE_COUNT=$(python3 - "$TRANSCRIPT_PATH" <<'PYEOF'
import json, sys
count = 0
with open(sys.argv[1]) as f:
    for line in f:
        try:
            entry = json.loads(line)
            msg = entry.get('message', {})
            if isinstance(msg, dict) and msg.get('role') == 'user':
                content = msg.get('content', '')
                if isinstance(content, str) and '<command-message>' in content:
                    continue
                count += 1
        except Exception:
            pass
print(count)
PYEOF
2>/dev/null)
else
    EXCHANGE_COUNT=0
fi

# Load last checkpoint
LAST_CP_FILE="$STATE_DIR/${SESSION_ID}_checkpoint.wm"
LAST_CP=0
[ -f "$LAST_CP_FILE" ] && LAST_CP=$(cat "$LAST_CP_FILE")

SINCE_LAST=$((EXCHANGE_COUNT - LAST_CP))

ENG=0
if is_eng_cwd "$CWD"; then ENG=1; fi
VENTURE=$(venture_from_cwd "$CWD")

echo "[$(date '+%H:%M:%S')] session=${SESSION_ID:0:8} exchanges=$EXCHANGE_COUNT since_last=$SINCE_LAST interval=$SAVE_INTERVAL eng=$ENG cwd=$CWD venture=$VENTURE" >> "$LOG"

if [ "$SINCE_LAST" -ge "$SAVE_INTERVAL" ] && [ "$EXCHANGE_COUNT" -gt 0 ]; then
    echo "$EXCHANGE_COUNT" > "$LAST_CP_FILE"
    echo "[$(date '+%H:%M:%S')] TRIGGERING CHECKPOINT at exchange $EXCHANGE_COUNT eng=$ENG" >> "$LOG"

    if [ "$ENG" = "1" ]; then
      # Escape venture for JSON string
      VESC=$(printf '%s' "$VENTURE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))')
      cat << HOOKJSON
{
  "decision": "block",
  "reason": "ENG-KMS CHECKPOINT (compact) — eng-kms ONLY http://localhost:8181/mcp userId=eng_kms. Do NOT use personal-kms. Store AT MOST 3 high-signal items via unified_store with metadata lane=project|learning and venture=${VENTURE}. Prefer: (1) durable decision+why, (2) one correction Rich made, (3) one procedure that unblocked work. Skip transcripts, tool logs, PR noise, already-known facts, and anything ephemeral. Short content. Then resume your task if work remains; stop only if it is done."
}
HOOKJSON
    else
      cat << 'HOOKJSON'
{
  "decision": "block",
  "reason": "KMS CHECKPOINT (compact) — unified_store userId=richard_yaker, AT MOST 3 high-signal items (decision+why, correction, procedure). Skip ephemeral noise and anything already in KMS. Then resume your task if work remains; stop only if it is done."
}
HOOKJSON
    fi
else
    echo "{}"
fi
