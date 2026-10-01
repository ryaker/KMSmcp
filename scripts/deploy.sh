#!/usr/bin/env bash
# Stage a release of the KMS MCP server on the internal disk and (re)start the launchd agents.
#
#   scripts/deploy.sh            build, install prod deps, swap `current`, restart both agents
#   scripts/deploy.sh rollback   point `current` at the previous release and restart
#   scripts/deploy.sh status     show the live release and agent health
#   KMS_NO_RESTART=1 scripts/deploy.sh   stage and swap only, leave the agents alone (for testing)
#
# The live servers never read this checkout, so dev work, tests and worktrees (which live on the
# external /Volumes/Dev drive) cannot break or race production, and a missing mount cannot stop
# a launchd restart. Data stays where it already is (~/.kms-eng, ~/.kms-sparrowdb-v2,
# ~/.claude-ops); a deploy never touches it.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
DEPLOY_ROOT=${KMS_DEPLOY_ROOT:-$HOME/.kms-mcp}
# launchd runs this node, and better-sqlite3 is compiled against its ABI, so the deploy must
# `npm ci` with the same binary (the shell's nvm node is a different major version).
NODE=${KMS_NODE:-/opt/homebrew/bin/node}
export PATH="$(dirname "$NODE"):$PATH"
KEEP=2                                   # releases kept for rollback (~420 MB each on the internal disk)
# label|doppler config|log basename -- the two agents differ only in these three fields
AGENTS=("com.ryaker.kms-mcp-eng|dev_eng|kms-mcp-eng" "com.ryaker.kms-mcp|dev_personal|kms-mcp")
UID_=$(id -u)

die() { echo "deploy.sh: $*" >&2; exit 1; }
agent_field() { local IFS='|'; read -ra f <<<"$1"; echo "${f[$2]}"; }

restart_agents() {
  for a in "${AGENTS[@]}"; do
    local label cfg log plist
    label=$(agent_field "$a" 0); cfg=$(agent_field "$a" 1); log=$(agent_field "$a" 2)
    plist="$HOME/Library/LaunchAgents/$label.plist"
    sed -e "s#@LABEL@#$label#g" -e "s#@DOPPLER_CONFIG@#$cfg#g" -e "s#@LOG_NAME@#$log#g" \
        -e "s#@NODE@#$NODE#g" -e "s#@DEPLOY_ROOT@#$DEPLOY_ROOT#g" -e "s#@HOME@#$HOME#g" \
        "$REPO/scripts/launchd/kms-mcp.plist.tmpl" >"$plist.new"
    plutil -lint "$plist.new" >/dev/null || die "rendered plist for $label is invalid"
    mv "$plist.new" "$plist"
    # bootout+bootstrap, not kickstart: launchd reads WorkingDirectory only when the job is loaded.
    launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_" "$plist"
  done
}

health() {  # wait for /health on each agent's own port (HTTP_PORT comes from its Doppler config)
  local bad=0
  for a in "${AGENTS[@]}"; do
    local label cfg port ok=0
    label=$(agent_field "$a" 0); cfg=$(agent_field "$a" 1)
    port=$(doppler run --project ry-local --config "$cfg" -- sh -c 'echo "$HTTP_PORT"')
    for _ in $(seq 1 30); do
      curl -fsS -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1 && { ok=1; break; }
      sleep 1
    done
    if [ $ok = 1 ]; then echo "  ok    $label :$port"; else echo "  DOWN  $label :$port (see ~/Library/Logs)"; bad=1; fi
  done
  return $bad
}

live() { readlink "$DEPLOY_ROOT/current" 2>/dev/null | xargs -n1 basename 2>/dev/null || echo none; }

swap_to() {  # atomic: build the new symlink beside `current`, then rename over it
  ln -sfn "$DEPLOY_ROOT/releases/$1" "$DEPLOY_ROOT/current.new"
  mv -fh "$DEPLOY_ROOT/current.new" "$DEPLOY_ROOT/current"
}

case "${1:-deploy}" in
  status) echo "live release: $(live)"; health; exit $? ;;
  rollback)
    prev=$(ls -1 "$DEPLOY_ROOT/releases" | sort | grep -B1 -x "$(live)" | head -1)
    [ -n "$prev" ] && [ "$prev" != "$(live)" ] || die "no earlier release to roll back to"
    echo "rolling back $(live) -> $prev"; swap_to "$prev"; restart_agents; health; exit $? ;;
  deploy) ;;
  *) die "usage: deploy.sh [deploy|rollback|status]" ;;
esac

[ -x "$REPO/node_modules/.bin/tsc" ] || die "no node_modules in $REPO; run npm ci there first"
sha=$(git -C "$REPO" rev-parse --short HEAD)
dirty=""; [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no -- src package.json package-lock.json tsconfig.json)" ] || dirty="-dirty"
rel="$(date +%Y%m%d-%H%M%S)-$sha$dirty"
stage="$DEPLOY_ROOT/releases/$rel"
mkdir -p "$stage"
trap '[ -e "$DEPLOY_ROOT/current" ] && [ "$(live)" = "$rel" ] || rm -rf "$stage"' EXIT   # drop half-built releases

echo "building $rel"
(cd "$REPO" && node_modules/.bin/tsc --outDir "$stage/dist")      # not `npm run build`: leaves the repo's tracked dist/ alone
cp "$REPO/package.json" "$REPO/package-lock.json" "$stage/"
# `prepare` only sets this repo's git hooks path; there is no git dir in a release.
"$NODE" "$(dirname "$NODE")/npm" --prefix "$stage" pkg delete scripts.prepare >/dev/null
(cd "$stage" && "$NODE" "$(dirname "$NODE")/npm" ci --omit=dev --no-audit --no-fund --loglevel=error)

# The release must load its native addons and entrypoint under launchd's node before it goes live.
(cd "$stage" && "$NODE" -e "require('better-sqlite3'); require('sparrowdb')") || die "native modules failed to load under $NODE"
[ -f "$stage/dist/index.js" ] || die "build produced no dist/index.js"

prev=$(live)
swap_to "$rel"
if [ "${KMS_NO_RESTART:-0}" = 1 ]; then trap - EXIT; echo "staged $rel (KMS_NO_RESTART=1: agents not touched)"; exit 0; fi
restart_agents
echo "health:"
if ! health; then
  echo "unhealthy; rolling back to $prev" >&2
  [ "$prev" != none ] && { swap_to "$prev"; restart_agents; health || true; }
  exit 1
fi
trap - EXIT
ls -1 "$DEPLOY_ROOT/releases" | sort | head -n -$KEEP | while read -r old; do rm -rf "${DEPLOY_ROOT:?}/releases/${old:?}"; done
echo "live: $rel   (rollback: scripts/deploy.sh rollback)"
echo "next: confirm with a real unified_store; the router should report JevStorageRouter(jev, …)"
