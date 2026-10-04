#!/usr/bin/env bash
# Daily KMS health + resource report. Light by design: this Mac has 16 GB RAM and runs many
# projects, so everything here is bounded, niced (by the launchd plist) and skippable.
#
#   kms-health-report.sh            write ~/.kms-mcp/reports/<date>.md, update latest.md,
#                                   notify only when something needs attention
#   KMS_REPORT_DIR=...              write elsewhere (tests)
#   KMS_REPORT_NO_NOTIFY=1          never notify
#
# Sections: ATTENTION (thresholds below), services, embedder, Jev, resources, worktrees, backlog.
set -uo pipefail

ROOT=${KMS_DEPLOY_ROOT:-$HOME/.kms-mcp}
OUT=${KMS_REPORT_DIR:-$ROOT/reports}
DECISION_LOGS=${KMS_DECISION_LOG_DIR:-$HOME/.kms/decision-log}
DEV=/Volumes/Dev
REPO=$DEV/KMSmcp
mkdir -p "$OUT"; chmod 700 "$OUT"
day=$(date +%Y-%m-%d); file="$OUT/$day.md"
attn=()   # one line per thing that needs a human

# Thresholds (each is a judgment call, kept in one place):
SWAP_PCT=85          # swap this full means the 16 GB machine is thrashing
DISK_FREE_PCT=10     # internal disk and /Volumes/Dev
DISK_DROP_GB=50      # free space lost since the previous report
LOG_MB=100           # any single KMS log or decision log
JEV_FAIL_PCT=5       # share of recent Jev candidate judgments failing
STALE_WT_DAYS=7      # worktree with no commit this long
IGNORE=${KMS_REPORT_IGNORE:-$ROOT/report-ignore}   # one path substring per line: deliberate long-lived worktrees

emit() { printf '%s\n' "$*" >>"$file.body"; }
: >"$file.body"

# --- services -------------------------------------------------------------------------------
emit "## Services"
emit "- live release: $(readlink "$ROOT/current" 2>/dev/null | xargs -n1 basename 2>/dev/null || echo none)"
for a in "com.ryaker.kms-mcp-eng:8181" "com.ryaker.kms-mcp:8180"; do
  label=${a%%:*}; port=${a##*:}
  code=$(curl -s -m 4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health" 2>/dev/null)
  emit "- $label :$port health=$code"
  [ "$code" = 200 ] || attn+=("$label is not healthy on :$port (health=$code)")
done

# --- embedder (dedup needs it) --------------------------------------------------------------
emit; emit "## Embedder (Ollama on rym1)"
oll=$(doppler run --project ry-local --config dev_eng -- sh -c 'echo "$OLLAMA_BASE_URL"' 2>/dev/null)
oll=${oll:-http://100.127.128.76:11434}
if dims=$(curl -s -m 15 "$oll/api/embeddings" -d '{"model":"nomic-embed-text","prompt":"ping"}' 2>/dev/null \
    | jq -r '.embedding|length' 2>/dev/null) && [ "${dims:-0}" -gt 0 ]; then
  emit "- $oll embeds OK ($dims dims)"
else
  emit "- $oll NOT answering; dedup runs unchecked until it is back"
  attn+=("Ollama embedder on rym1 is down; every store is skipping dedup (restart ollama serve there)")
fi

# --- Jev -------------------------------------------------------------------------------------
emit; emit "## Jev"
rep="$ROOT/current/dist/scripts/shadow-eval-report.js"
if [ -f "$rep" ] && json=$(timeout 60 node "$rep" --json 2>/dev/null); then
  emit "- shadow runs: $(jq -r '.totals.runs' <<<"$json") (gate 200), $(jq -r '.rate.runsPerDay|floor' <<<"$json")/day"
  emit "- latency p50/p95: $(jq -r '.totals.p50LatencyMs' <<<"$json") / $(jq -r '.totals.p95LatencyMs' <<<"$json") ms; cost \$$(jq -r '.totals.totalCostUsd*100|round/100' <<<"$json") total"
  emit "- candidate judgments failed (all time): $(jq -r '.totals.candidatesFailed' <<<"$json") of $(jq -r '.totals.candidatesEvaluated' <<<"$json")"
else
  emit "- shadow report unavailable ($rep)"
fi
# Recent window, not all-time: all-time numbers hide an outage that started this morning.
log="$DECISION_LOGS/eng-recall-shadow.jsonl"
if [ -f "$log" ]; then
  recent=$(tail -n 50 "$log" | jq -s '{runs:length, eval:(map(.candidates_evaluated)|add // 0), failed:(map(.candidates_failed)|add // 0),
            credits:([.[]|.. |strings|select(startswith("APIError: 402"))]|length)}' 2>/dev/null)
  if [ -n "$recent" ]; then
    ev=$(jq -r .eval <<<"$recent"); fl=$(jq -r .failed <<<"$recent"); cr=$(jq -r .credits <<<"$recent")
    pct=$(( ev > 0 ? 100 * fl / ev : 0 ))
    emit "- last 50 runs: $fl of $ev judgments failed (${pct}%), 402-credit errors: $cr; latest run $(tail -n 1 "$log" | jq -r .at)"
    [ "$cr" -gt 0 ] && attn+=("TypeSafe/Jev credits exhausted (HTTP 402 in $cr recent judgments); Jev features are falling back to local models")
    [ "$cr" -eq 0 ] && [ "$pct" -ge $JEV_FAIL_PCT ] && attn+=("Jev judgments failing: ${pct}% of the last 50 runs")
  fi
fi
emit "- flags: $(doppler run --project ry-local --config dev_eng -- env 2>/dev/null | grep -E '^KMS_JEV_' | grep -v -i -E 'KEY|TOKEN|SECRET|PASS' | tr '\n' ' ')"

# --- resources --------------------------------------------------------------------------------
emit; emit "## Resources"
swap=$(sysctl -n vm.swapusage 2>/dev/null)
used=$(sed -E 's/.*used = ([0-9.]+)M.*/\1/' <<<"$swap"); tot=$(sed -E 's/.*total = ([0-9.]+)M.*/\1/' <<<"$swap")
spct=$(awk -v u="${used:-0}" -v t="${tot:-1}" 'BEGIN{printf "%d", 100*u/t}')
emit "- swap: ${used}M of ${tot}M (${spct}%); $(memory_pressure 2>/dev/null | tail -1)"
[ "$spct" -ge $SWAP_PCT ] && attn+=("swap ${spct}% full; close something (top RAM below)")
emit "- top RAM:"; ps -axo rss,comm | sort -rn | head -5 | awk '{printf "    %5.0f MB  %s\n",$1/1024,$2}' | sed 's#/System/Library/[^ ]*/\([^/ ]*\)$#\1#' | cut -c1-80 >>"$file.body"
for m in / $DEV; do
  [ -d "$m" ] || { emit "- $m not mounted"; continue; }
  read -r _ size usedg free pct _ < <(df -g "$m" | tail -1)
  emit "- disk $m: ${free} GB free (${pct} used)"
  [ "$(df -k "$m" | tail -1 | awk '{printf "%d", 100*$4/($3+$4)}')" -lt $DISK_FREE_PCT ] && attn+=("$m has under ${DISK_FREE_PCT}% free (${free} GB)")
  key=$(echo "$m" | tr / _); prev="$OUT/.free$key"
  [ -f "$prev" ] && { d=$(( $(cat "$prev") - free )); emit "  - change since last report: $((-d)) GB"; [ $d -ge $DISK_DROP_GB ] && attn+=("$m lost ${d} GB free since the last report"); }
  echo "$free" >"$prev"
done
for f in "$HOME"/Library/Logs/kms-mcp*.log "$DECISION_LOGS"/*.jsonl; do
  [ -f "$f" ] || continue; mb=$(( $(stat -f%z "$f") / 1048576 ))
  [ $mb -ge $LOG_MB ] && attn+=("$(basename "$f") is ${mb} MB; rotate or cap it")
done
emit "- decision logs: $(du -sh "$DECISION_LOGS" 2>/dev/null | cut -f1); releases: $(du -sh "$ROOT/releases" 2>/dev/null | cut -f1); reports: $(du -sh "$OUT" 2>/dev/null | cut -f1)"
# The expensive scan only on Sundays, and only if the volume is mounted.
if [ "$(date +%u)" = 7 ] && [ -d "$DEV" ] && [ "${KMS_REPORT_SKIP_WEEKLY:-0}" != 1 ]; then
  emit "- /Volumes/Dev biggest top-level dirs (weekly scan):"
  timeout 600 du -d1 -g "$DEV" 2>/dev/null | sort -rn | sed -n '2,9p' | awk '{printf "    %5d GB  %s\n",$1,$2}' >>"$file.body"
fi

# --- worktrees --------------------------------------------------------------------------------
emit; emit "## Worktrees (every git repo under $DEV)"
if [ -d "$DEV" ]; then
  n=0
  for r in "$DEV"/*/; do
    [ -d "$r/.git" ] || continue          # main repos only; a worktree's .git is a file
    git -C "$r" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | tail -n +2 | while read -r w; do
      sz=$(du -sh "$w" 2>/dev/null | cut -f1)
      last=$(git -C "$w" log -1 --format=%cs 2>/dev/null || echo unreadable)
      echo "$(basename "$r")|$w|$sz|$last"
    done
  done >"$file.wt"
  while IFS='|' read -r repo w sz last; do
    emit "- $repo: $w ($sz, last commit $last)"; n=$((n+1))
    [ -f "$IGNORE" ] && grep -q -F -f "$IGNORE" <<<"$w" && continue
    if [ "$last" = unreadable ]; then attn+=("worktree $w is unreadable by git (run git worktree repair or remove)")
    elif [ "$(( ( $(date +%s) - $(date -j -f %Y-%m-%d "$last" +%s 2>/dev/null || echo 0) ) / 86400 ))" -ge $STALE_WT_DAYS ]; then
      attn+=("worktree $w idle ${STALE_WT_DAYS}+ days (finish, merge or remove)")
    fi
  done <"$file.wt"; rm -f "$file.wt"
  [ $n = 0 ] && emit "- none"
  [ -x "$ROOT/bin/worktree-clean.sh" ] && (cd "$REPO" && emit "- KMSmcp cleanup dry run: $(timeout 120 "$ROOT/bin/worktree-clean.sh" 2>&1 | tail -1)")
else emit "- $DEV not mounted"; fi

# --- backlog ------------------------------------------------------------------------------------
emit; emit "## Backlog (KMSmcp)"
emit "- open PRs: $(cd "$REPO" 2>/dev/null && timeout 30 gh pr list --state open --json number --jq length 2>/dev/null || echo '?'), open issues: $(cd "$REPO" 2>/dev/null && timeout 30 gh issue list --state open --json number --jq length 2>/dev/null || echo '?')"

# --- assemble -----------------------------------------------------------------------------------
{
  echo "# KMS health report — $(date '+%Y-%m-%d %H:%M %Z')"; echo
  if [ ${#attn[@]} -gt 0 ]; then echo "## ATTENTION ($(printf '%s\n' "${attn[@]}" | sort -u | wc -l | tr -d ' '))"; printf '%s\n' "${attn[@]}" | awk '!seen[$0]++ {print "- " $0}'; else echo "## ATTENTION"; echo "- nothing needs attention"; fi
  echo; cat "$file.body"
} >"$file"; rm -f "$file.body"; chmod 600 "$file"
ln -sf "$file" "$OUT/latest.md"
# keep 30 days (awk, not `head -n -30`: BSD head has no negative counts)
ls -1 "$OUT"/20*.md 2>/dev/null | sort | awk '{a[NR]=$0} END{for(i=1;i<=NR-30;i++)print a[i]}' | while read -r old; do rm -f "$old"; done

if [ ${#attn[@]} -gt 0 ] && [ "${KMS_REPORT_NO_NOTIFY:-0}" != 1 ]; then
  osascript -e "display notification \"${attn[0]//\"/}\" with title \"KMS: ${#attn[@]} item(s) need attention\" subtitle \"$file\"" >/dev/null 2>&1 || true
fi
echo "$file"
