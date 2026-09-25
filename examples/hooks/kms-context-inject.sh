#!/usr/bin/env bash
# kms-context-inject.sh — Smart KMS context injection
# Only surfaces high-confidence, relevant memories — not everything.
# Silent on ALL failures — never blocks the user.

LOG=/tmp/kms-hook-debug.log
exec 2>>"$LOG"

# Always emit valid JSON on exit — Claude Code requires it even when there's nothing to inject
_OUTPUT_SENT=0
trap '[[ $_OUTPUT_SENT -eq 0 ]] && echo "{}"' EXIT

TIMEOUT=8

# Read stdin
INPUT=$(cat)

# --- eng-kms Phase 0.1: cwd-aware recall (mirror checkpoint routing) ---
# Dev /Volumes/Dev → eng-kms :8181 / eng_kms
# else → personal :8180 / richard_yaker
eval $(echo "$INPUT" | python3 -c '
import sys, json, re
try:
    data = json.load(sys.stdin)
except Exception:
    print("CWD=\"\"")
    print("TRANSCRIPT_PATH=\"\"")
    raise SystemExit(0)
cwd = data.get("cwd") or data.get("working_directory") or data.get("cwd_path") or ""
if not cwd and isinstance(data.get("session"), dict):
    cwd = data["session"].get("cwd") or ""
tp = data.get("transcript_path", "") or ""
safe = lambda s: re.sub(r"[^a-zA-Z0-9_/.\-~ ]", "", str(s))
print(f"CWD=\"{safe(cwd)}\"")
print(f"TRANSCRIPT_PATH=\"{safe(tp)}\"")
' 2>/dev/null)

CWD="${CWD/#\~/$HOME}"
TRANSCRIPT_PATH="${TRANSCRIPT_PATH/#\~/$HOME}"
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

if is_eng_cwd "$CWD"; then
  KMS_URL="http://localhost:8181/mcp"
  KMS_USER_ID="eng_kms"
  KMS_LABEL="ENG-KMS"
else
  KMS_URL="http://localhost:8180/mcp"
  KMS_USER_ID="richard_yaker"
  KMS_LABEL="KMS"
fi
echo "INJECT lane=$KMS_LABEL url=$KMS_URL userId=$KMS_USER_ID cwd=$CWD" >> "$LOG"

# Extract prompt + classify intent
SEARCH_CONFIG=$(python3 -c "
import sys, json, re

try:
    data = json.loads(sys.stdin.read())
    prompt = data.get('prompt', '') or data.get('message', '') or data.get('content', '')
    if not prompt:
        for entry in reversed(data.get('transcript', [])):
            if entry.get('role') == 'human':
                content = entry.get('content', '')
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get('type') == 'text':
                            prompt = block.get('text', '')
                            break
                elif isinstance(content, str):
                    prompt = content
                if prompt:
                    break

    prompt = prompt[:400].strip()
    if len(prompt) < 10:
        sys.exit(0)

    # Skip non-semantic prompts that shouldn't trigger KMS lookup
    p_check = prompt.lower()
    if (p_check.startswith('<task-notification>')
            or p_check.startswith('file://')
            or p_check.startswith('http://')
            or p_check.startswith('https://')
            or p_check.startswith('<system-reminder>')
            or re.match(r'^[\w\-]+$', prompt)):  # single word / UUID
        sys.exit(0)

    p = p_check

    # Classify: technical = code/infra/debug focused
    is_technical = bool(re.search(r'\b(bug|fix|error|code|deploy|build|api|server|config|port|install|debug|test|function|class|typescript|python|node|npm|docker|git|ssh|auth|oauth|redis|mongo|neo4j|postgres|sql|curl|bash|script)\b', p))

    # Classify: project = asking about specific projects/relationships
    is_project = bool(re.search(r'\b(project|repo|app|service|kms|mcp|coaching|abundance|sophia|nanobanana|claude|agent|bus|ops|zora|railway|cloudflare|tunnel)\b', p))

    # Content types based on intent
    if is_technical and is_project:
        content_types = ['fact', 'procedure', 'insight', 'memory']
        include_relationships = True
    elif is_technical:
        content_types = ['procedure', 'fact', 'insight']
        include_relationships = False
    elif is_project:
        content_types = ['insight', 'memory', 'pattern', 'fact']
        include_relationships = True
    else:
        # Personal/general — only high-value personal context
        content_types = ['memory', 'insight', 'pattern']
        include_relationships = False

    result = {
        'query': prompt,
        'contentTypes': content_types,
        'includeRelationships': include_relationships
    }
    print(json.dumps(result))
except Exception:
    sys.exit(0)
" <<< "$INPUT" 2>/dev/null)

if [ -z "$SEARCH_CONFIG" ]; then
    echo "EXIT: prompt too short or parse failed" >> "$LOG"
    exit 0
fi
echo "SEARCH_CONFIG=$SEARCH_CONFIG" >> "$LOG"

# Initialize MCP session
INIT_RAW=$(curl -si --max-time "$TIMEOUT" \
    -X POST "$KMS_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"kms-hook","version":"1.0"}}}' \
    2>/dev/null)

echo "INIT curl exit=$?" >> "$LOG"
[ $? -ne 0 ] || [ -z "$INIT_RAW" ] && { echo "EXIT: init failed" >> "$LOG"; exit 0; }

SESSION_ID=$(echo "$INIT_RAW" | grep -i "^mcp-session-id:" | sed 's/mcp-session-id: *//i' | tr -d '\r\n')
echo "SESSION_ID=$SESSION_ID" >> "$LOG"
[ -z "$SESSION_ID" ] && { echo "EXIT: no session id" >> "$LOG"; exit 0; }

# Build search payload with smart filters
SEARCH_PAYLOAD=$(KMS_USER_ID="$KMS_USER_ID" python3 -c "
import json, sys, os
config = json.loads(sys.argv[1])
uid = os.environ.get('KMS_USER_ID', 'richard_yaker')
payload = {
    'jsonrpc': '2.0',
    'id': 1,
    'method': 'tools/call',
    'params': {
        'name': 'unified_search',
        'arguments': {
            'query': config['query'],
            'filters': {
                'userId': uid,
                'contentType': config['contentTypes'],
                'minConfidence': 0.70
            },
            'options': {
                'maxResults': 10,
                'includeRelationships': config['includeRelationships'],
                'cacheStrategy': 'conservative'
            }
        }
    }
}
print(json.dumps(payload))
" "$SEARCH_CONFIG" 2>/dev/null)

[ -z "$SEARCH_PAYLOAD" ] && exit 0

SEARCH_RAW=$(curl -s --max-time "$TIMEOUT" \
    -X POST "$KMS_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SESSION_ID" \
    -d "$SEARCH_PAYLOAD" \
    2>/dev/null)

CURL_EXIT=$?
[ $CURL_EXIT -ne 0 ] || [ -z "$SEARCH_RAW" ] && { echo "EXIT: search curl failed (exit=$CURL_EXIT)" >> "$LOG"; exit 0; }

SEARCH_JSON=$(echo "$SEARCH_RAW" | grep "^data:" | head -1 | sed 's/^data: *//')
echo "SEARCH curl exit=0, response len=$(echo "$SEARCH_RAW" | wc -c), JSON len=$(echo "$SEARCH_JSON" | wc -c)" >> "$LOG"
[ -z "$SEARCH_JSON" ] && SEARCH_JSON="$SEARCH_RAW"

# Format output inside an untrusted-data boundary (see kms_context_format.py)
FORMATTER="$(dirname "$0")/kms_context_format.py"
CONTEXT=$(KMS_LABEL="$KMS_LABEL" python3 "$FORMATTER" <<< "$SEARCH_JSON" 2>>"$LOG")

if [ -n "$CONTEXT" ]; then
    OUTPUT=$(python3 -c "
import json, sys
ctx = sys.stdin.read()
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': ctx}}))
" <<< "$CONTEXT" 2>/dev/null)
    if [ -n "$OUTPUT" ]; then
        _OUTPUT_SENT=1
        echo "$OUTPUT"
    fi
fi

# Close session (background, best-effort)
curl -s --max-time 3 -X DELETE "$KMS_URL" \
    -H "mcp-session-id: $SESSION_ID" \
    -H "Accept: application/json, text/event-stream" \
    >/dev/null 2>&1 &

exit 0
