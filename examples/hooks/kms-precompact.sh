#!/bin/bash
# kms-precompact.sh — Emergency save before context compaction
#
# Always blocks and tells Claude to save everything to KMS.
# Compaction destroys detailed session context; this is the safety net.
#
# Fires on the PreCompact hook event.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c \
    "import sys,json; print(json.load(sys.stdin).get('session_id','unknown'))" 2>/dev/null)

echo "[$(date '+%H:%M:%S')] PRE-COMPACT triggered session=${SESSION_ID:0:8}" \
    >> /tmp/kms-precompact-debug.log

cat << 'HOOKJSON'
{
  "decision": "block",
  "reason": "COMPACTION IMMINENT — context will be compressed and detail lost. Save everything worth keeping to KMS now. Call unified_store (userId=richard_yaker) for each item:\n- Decisions + reasoning (contentType=insight)\n- Technical facts learned (contentType=fact)\n- Corrections or patterns Rich gave (contentType=pattern, verbatim preferred)\n- Procedures that worked (contentType=procedure)\nAdd relationships array where items connect to known concepts. Be thorough — this is the last chance before detail is gone. Then allow compaction."
}
HOOKJSON
