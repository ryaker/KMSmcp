#!/bin/bash
# Run ON rym1 with sudo:  sudo bash ~/ollama-daemon/install.sh
# Makes Ollama a boot-time system daemon (runs as ryaker). Per-user LaunchAgents only load while
# someone is logged in at the console, and FileVault is on, so auto-login is not an option.
# Idempotent. Undo with uninstall.sh.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd)
U=ryaker; UH=/Users/$U; ARCH=$UH/.launchd-archive

for l in com.ollama.serve com.ollama.keep-model; do
  install -o root -g wheel -m 644 "$SRC/$l.plist" "/Library/LaunchDaemons/$l.plist"
  plutil -lint "/Library/LaunchDaemons/$l.plist" >/dev/null
done

# The old per-user agents would start a second server at login and fight the daemon for :11434.
sudo -u $U mkdir -p "$ARCH"
for l in com.ollama.serve com.ollama.keep-model; do
  [ -f "$UH/Library/LaunchAgents/$l.plist" ] && sudo -u $U mv "$UH/Library/LaunchAgents/$l.plist" "$ARCH/$l.plist.agent-$(date +%Y%m%d)"
done

# If ryaker is logged in, the per-user agents are LOADED: unload them or launchd respawns a
# second server within seconds of the kill below and it fights the daemon for :11434.
UID_U=$(id -u $U)
for l in com.ollama.serve com.ollama.keep-model; do launchctl bootout "gui/$UID_U/$l" 2>/dev/null || true; done
# Ollama.app also runs its own server on 127.0.0.1:11434 (a login item); it would shadow the
# daemon for local clients and load every model twice. Quit it for now; see the note at the end.
pkill -u $U -f '/Applications/Ollama.app/Contents/MacOS/Ollama' 2>/dev/null || true
pkill -u $U -f 'ollama serve' 2>/dev/null || true; sleep 2

for l in com.ollama.serve com.ollama.keep-model; do
  launchctl bootout "system/$l" 2>/dev/null || true
  launchctl bootstrap system "/Library/LaunchDaemons/$l.plist"
done

for _ in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:11434/api/version >/dev/null && break; sleep 1; done
echo "version: $(curl -s -m 3 http://127.0.0.1:11434/api/version || echo NOT ANSWERING)"
launchctl print system/com.ollama.serve | grep -E 'state =|pid ='
echo "done. Logs: $UH/Library/Logs/ollama-serve*.log"
echo "ONE MANUAL STEP: System Settings > General > Login Items & Extensions > turn OFF \"Ollama\"."
echo "  Otherwise the app starts its own server at every login and shadows the daemon on 127.0.0.1."
