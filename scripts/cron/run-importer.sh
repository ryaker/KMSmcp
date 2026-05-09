#!/usr/bin/env bash
#
# scripts/cron/run-importer.sh
#
# One-shot wrapper invoked by launchd every 15 min for each importer.
# Resolves Homebrew node/npx, sources project .env if present, captures
# stdout+stderr to a log under ~/Library/Logs/kms-cron/, and guards against
# concurrent runs with a PID-file lock (macOS doesn't ship `flock`).
#
# Usage:
#   scripts/cron/run-importer.sh granola         # → npx tsx scripts/import-granola.ts --source=cache-v6
#   scripts/cron/run-importer.sh slack-huddles   # → npx tsx src/scripts/import-slack-huddles-cli.ts
#
# Exit codes:
#   0 = importer exited 0
#   non-zero = importer exited non-zero (passes through), or wrapper error.
#   Special: 75 (EX_TEMPFAIL) = another instance still running, skipping this tick.
#
# Idempotency: each importer has its own state file
#   (~/.kms-granola-state.json, ~/.kms-slack-huddle-sync.json) so re-running
#   the same window just re-walks an already-processed list and stores nothing.
#   The PID-file lock here guards against a slow run still being in-flight when
#   the next 15-min tick arrives.
#
# Environment expectations:
#   - KMS at http://localhost:8180/mcp must be reachable.
#   - OAuth client_credentials env supplied via Doppler (preferred) or via .env.
#   - ANTHROPIC_API_KEY must be set (required for Haiku 4.5 distillation).

set -uo pipefail

# ─── Resolve repo root (this script lives at <repo>/scripts/cron/) ──────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── PATH: Homebrew first so we get node/npm/npx + doppler if installed ─────
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

# ─── Argument: importer name ────────────────────────────────────────────────
IMPORTER="${1:-}"
if [[ -z "$IMPORTER" ]]; then
  echo "❌ usage: $0 <granola|slack-huddles>" >&2
  exit 64  # EX_USAGE
fi

# Allow tests / overrides to swap the npx binary (default: whichever `npx`
# resolves on PATH after the Homebrew prepend above).
NPX_BIN="${KMS_CRON_NPX:-npx}"

case "$IMPORTER" in
  granola)
    IMPORTER_CMD=("$NPX_BIN" --yes tsx scripts/import-granola.ts --source=cache-v6)
    LOG_NAME="granola"
    ;;
  slack-huddles)
    IMPORTER_CMD=("$NPX_BIN" --yes tsx src/scripts/import-slack-huddles-cli.ts)
    LOG_NAME="slack-huddles"
    ;;
  *)
    echo "❌ unknown importer: $IMPORTER (expected: granola|slack-huddles)" >&2
    exit 64
    ;;
esac

# ─── Logging ────────────────────────────────────────────────────────────────
LOG_DIR="${KMS_CRON_LOG_DIR:-$HOME/Library/Logs/kms-cron}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${LOG_NAME}.log"

# Rotate the log if it's > 10 MB. Crude single-rotation: .log → .log.1.
if [[ -f "$LOG_FILE" ]]; then
  size=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
  if [[ "$size" -gt 10485760 ]]; then
    mv -f "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
  fi
fi

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

# ─── PID-file lock (macOS-friendly; no flock) ──────────────────────────────
LOCK_DIR="${KMS_CRON_LOCK_DIR:-$HOME/Library/Caches/kms-cron}"
mkdir -p "$LOCK_DIR"
LOCK_FILE="$LOCK_DIR/${LOG_NAME}.pid"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$LOCK_FILE" 2>/dev/null || echo '')"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      log "another run still in flight (pid=$existing_pid). skipping this tick."
      return 1
    fi
    log "stale lock (pid=$existing_pid not running). reclaiming."
    rm -f "$LOCK_FILE"
  fi
  echo "$$" > "$LOCK_FILE"
  return 0
}

release_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local pid
    pid="$(cat "$LOCK_FILE" 2>/dev/null || echo '')"
    if [[ "$pid" == "$$" ]]; then
      rm -f "$LOCK_FILE"
    fi
  fi
}

trap release_lock EXIT INT TERM

if ! acquire_lock; then
  exit 75  # EX_TEMPFAIL
fi

# ─── Optional: source repo .env (importers also accept env from launchd /
# Doppler — sourcing is a fallback when launching via cron-style tools). ────
if [[ -f "$REPO_ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  . "$REPO_ROOT/.env"
  set +a
fi

# ─── Run the importer ──────────────────────────────────────────────────────
cd "$REPO_ROOT"

log "starting ${LOG_NAME} importer: ${IMPORTER_CMD[*]}"
log "  cwd=$REPO_ROOT  PATH=$PATH"

# Use Doppler if available AND no bearer token is already set (lets a one-off
# overridden run via KMS_BEARER_TOKEN bypass Doppler).
RUN_PREFIX=()
if [[ -z "${KMS_BEARER_TOKEN:-}" ]] && command -v doppler >/dev/null 2>&1; then
  if [[ -n "${KMS_DOPPLER_PROJECT:-}" && -n "${KMS_DOPPLER_CONFIG:-}" ]]; then
    RUN_PREFIX=(doppler run --project "$KMS_DOPPLER_PROJECT" --config "$KMS_DOPPLER_CONFIG" --)
    log "using doppler: project=$KMS_DOPPLER_PROJECT config=$KMS_DOPPLER_CONFIG"
  fi
fi

start_ts="$(date +%s)"

# Run the importer, appending stdout+stderr to the rolling log.
# `${RUN_PREFIX[@]+"${RUN_PREFIX[@]}"}` expands to NOTHING when the array is
# empty — required because `set -u` (above) treats an unset array as an
# error. We don't run `set -e` because we want to capture the importer's
# exit code and propagate it ourselves (see "exit $status" below).
"${RUN_PREFIX[@]+"${RUN_PREFIX[@]}"}" "${IMPORTER_CMD[@]}" >> "$LOG_FILE" 2>&1
status=$?

end_ts="$(date +%s)"
duration=$((end_ts - start_ts))
log "finished ${LOG_NAME} importer: exit=$status duration=${duration}s"
log "─────────────────────────────────────────────────────────────"

exit "$status"
