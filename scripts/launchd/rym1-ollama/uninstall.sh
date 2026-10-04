#!/bin/bash
# Run ON rym1 with sudo: reverts install.sh (restores the per-user LaunchAgents).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
U=ryaker; UH=/Users/$U; ARCH=$UH/.launchd-archive
for l in com.ollama.serve com.ollama.keep-model; do
  launchctl bootout "system/$l" 2>/dev/null || true
  rm -f "/Library/LaunchDaemons/$l.plist"
  a=$(ls -1t "$ARCH/$l.plist.agent-"* 2>/dev/null | head -1 || true)
  [ -n "$a" ] && sudo -u $U cp "$a" "$UH/Library/LaunchAgents/$l.plist"
done
echo "reverted; log in at the rym1 console to load the agents again"
