#!/bin/bash
# kms-periodic-checkpoint.sh — Periodic blocking KMS save
#
# Stop hook. Every SAVE_INTERVAL human messages, blocks and tells Claude
# to do a structured KMS save with full conversational context.
#
# This is DIFFERENT from kms-session-extract.py (which does silent
# regex-based nugget extraction on every turn). This hook fires less often
# but asks Claude itself to save — capturing reasoning, context, and
# relationships that regex patterns miss.
#
# Infinite-loop prevention: stop_hook_active=true means Claude already
# completed a save this cycle — let it stop normally.

SAVE_INTERVAL=20
STATE_DIR="$HOME/.claude/hooks/kms-watermarks"
LOG=/tmp/kms-checkpoint-debug.log

INPUT=$(cat)

# Parse session_id, stop_hook_active, transcript_path in one python call
eval $(echo "$INPUT" | python3 -c "
import sys, json, re
data = json.load(sys.stdin)
sid   = data.get('session_id', 'unknown')
sha   = data.get('stop_hook_active', False)
tp    = data.get('transcript_path', '')
safe  = lambda s: re.sub(r'[^a-zA-Z0-9_/.\-~]', '', str(s))
print(f'SESSION_ID=\"{safe(sid)}\"')
print(f'STOP_HOOK_ACTIVE=\"{sha}\"')
print(f'TRANSCRIPT_PATH=\"{safe(tp)}\"')
" 2>/dev/null)

# Expand ~ in path
TRANSCRIPT_PATH="${TRANSCRIPT_PATH/#\~/$HOME}"

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

echo "[$(date '+%H:%M:%S')] session=${SESSION_ID:0:8} exchanges=$EXCHANGE_COUNT since_last=$SINCE_LAST interval=$SAVE_INTERVAL" >> "$LOG"

if [ "$SINCE_LAST" -ge "$SAVE_INTERVAL" ] && [ "$EXCHANGE_COUNT" -gt 0 ]; then
    echo "$EXCHANGE_COUNT" > "$LAST_CP_FILE"
    echo "[$(date '+%H:%M:%S')] TRIGGERING CHECKPOINT at exchange $EXCHANGE_COUNT" >> "$LOG"

    cat << 'HOOKJSON'
{
  "decision": "block",
  "reason": "KMS CHECKPOINT — save session knowledge before stopping. Call unified_store (userId=richard_yaker) for each item worth keeping:\n- Decisions + why (contentType=insight)\n- Technical facts discovered (contentType=fact)\n- Corrections or patterns Rich gave (contentType=pattern, verbatim quote preferred)\n- Procedures that worked (contentType=procedure)\nAdd relationships array where items connect to known concepts. Skip anything ephemeral or already in KMS. Then allow the session to end."
}
HOOKJSON
else
    echo "{}"
fi
