# Ollama as a boot-time daemon on rym1 (the M1 mini)

KMS uses Ollama on rym1 (`OLLAMA_BASE_URL=http://100.127.128.76:11434`) for the embedder
(dedup Tier 1) and the dedup judge (Tier 2). When it is down every store reports
`dedup_unchecked`.

## Why a daemon, not a LaunchAgent
The original setup was two per-user LaunchAgents in `~/Library/LaunchAgents`. Those load only
while ryaker is logged in at the console, so Ollama died when the session logged out (Oct 3
2026) and stayed down. FileVault is on, which rules out auto-login. A LaunchDaemon in
`/Library/LaunchDaemons` starts at boot, survives logout, and runs as `ryaker` (`UserName`).

## Install / undo (on rym1, needs sudo)
    sudo bash ~/ollama-daemon/install.sh      # copy this directory to ~/ollama-daemon first
    sudo bash ~/ollama-daemon/uninstall.sh

`install.sh` also unloads the per-user agents (they would respawn a second server and fight the
daemon for :11434) and quits Ollama.app's own server, then verifies `:11434` answers.

## One manual step
Turn off **Ollama** under System Settings > General > Login Items & Extensions. The menu bar app
otherwise starts its own server on 127.0.0.1:11434 at every login, shadowing the daemon for local
clients and loading each model twice (the model is ~7 GiB on a 16 GB machine that also runs CI).

## Settings (same as the old agent)
`OLLAMA_HOST=0.0.0.0:11434`, `OLLAMA_KEEP_ALIVE=30m` (frees the model after 30 idle minutes).
`com.ollama.keep-model` warms `gemma4:12b-mlx` once at boot via `~/.local/bin/ollama-keep-model.sh`.

## Check
    launchctl print system/com.ollama.serve | grep -E 'state|pid'
    curl -s http://100.127.128.76:11434/api/version
