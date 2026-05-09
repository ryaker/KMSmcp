# KMS Cron Importers (launchd)

This directory contains the launchd plists and runner script that drive the
Granola and Slack-huddle KMS importers on a 15-minute schedule.

## Files

| File | Purpose |
| --- | --- |
| `run-importer.sh` | Single wrapper invoked by both plists. Resolves Homebrew node, sources `.env`, optionally wraps with `doppler run`, captures all output to `~/Library/Logs/kms-cron/<importer>.log`, and guards concurrent runs with a PID-file lock. |
| `com.ryaker.kms-granola-importer.plist` | launchd job — fires `run-importer.sh granola` every 900 s. Reads from `~/Library/Application Support/Granola/cache-v6.json`; watermark at `~/.kms-granola-state.json`. |
| `com.ryaker.kms-slack-huddle-importer.plist` | launchd job — fires `run-importer.sh slack-huddles` every 900 s. Sync log at `~/.kms-slack-huddle-sync.json`. |

## Install

```bash
# Copy plists into ~/Library/LaunchAgents
cp scripts/cron/com.ryaker.kms-granola-importer.plist        ~/Library/LaunchAgents/
cp scripts/cron/com.ryaker.kms-slack-huddle-importer.plist   ~/Library/LaunchAgents/

# Load each job (the -w flag writes the enable bit so it survives reboot)
launchctl load -w ~/Library/LaunchAgents/com.ryaker.kms-granola-importer.plist
launchctl load -w ~/Library/LaunchAgents/com.ryaker.kms-slack-huddle-importer.plist
```

## Verify

```bash
# Should list both jobs
launchctl list | grep com.ryaker.kms-

# Tail the rolling logs
tail -f ~/Library/Logs/kms-cron/granola.log
tail -f ~/Library/Logs/kms-cron/slack-huddles.log

# Trigger a one-off run (bypasses the 15-min schedule)
launchctl start com.ryaker.kms-granola-importer
launchctl start com.ryaker.kms-slack-huddle-importer
```

## Uninstall

```bash
launchctl unload -w ~/Library/LaunchAgents/com.ryaker.kms-granola-importer.plist
launchctl unload -w ~/Library/LaunchAgents/com.ryaker.kms-slack-huddle-importer.plist
rm ~/Library/LaunchAgents/com.ryaker.kms-granola-importer.plist
rm ~/Library/LaunchAgents/com.ryaker.kms-slack-huddle-importer.plist
```

## What runs every 15 min

```
# granola
cd /Users/ryaker/Dev/KMSmcp \
  && doppler run --project ry-local --config dev_personal -- \
       npx --yes tsx scripts/import-granola.ts --source=cache-v6

# slack-huddles
cd /Users/ryaker/Dev/KMSmcp \
  && doppler run --project ry-local --config dev_personal -- \
       npx --yes tsx src/scripts/import-slack-huddles-cli.ts
```

The `doppler run` prefix is added automatically when (a) `doppler` is on PATH,
(b) `KMS_BEARER_TOKEN` is unset, and (c) `KMS_DOPPLER_PROJECT` /
`KMS_DOPPLER_CONFIG` env vars are set (the plists supply the latter).

## Idempotency

Both importers are safe to run repeatedly:

| Importer | Resumability state |
| --- | --- |
| Granola (`--source=cache-v6`) | Watermark file `~/.kms-granola-state.json` tracks the last processed `endTs`; older meetings are skipped. |
| Slack huddles | Sync log `~/.kms-slack-huddle-sync.json` lists processed huddle IDs; existing IDs are skipped. |

In addition, every successful KMS write goes through the dedup gate
(`unified_store`), so even if a state file is wiped the gate refuses
near-duplicates rather than re-storing them.

The wrapper itself takes a PID-file lock at
`~/Library/Caches/kms-cron/<importer>.pid`. If a previous tick is still
in flight when the next one fires, the new invocation logs
`another run still in flight` and exits with code `75` (`EX_TEMPFAIL`).
launchd treats this as a normal exit and tries again on the next interval.

## Logs

| Path | Contents |
| --- | --- |
| `~/Library/Logs/kms-cron/granola.log` | Per-tick wrapper banner + full importer stdout/stderr. Rotates to `.log.1` past 10 MB. |
| `~/Library/Logs/kms-cron/slack-huddles.log` | Same for the slack-huddle importer. |
| `~/Library/Logs/kms-cron/<name>.launchd.log` | Tiny wrapper-level launchd capture (process spawn / exit / `set -u` violations). Usually empty. |

## Required environment

The runner expects either:

1. `KMS_BEARER_TOKEN` set in the environment (one-off / debug runs), or
2. Doppler on `PATH` with the `KMS_DOPPLER_PROJECT` + `KMS_DOPPLER_CONFIG` plist
   keys pointing at a config that supplies:
   - `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_TOKEN_ENDPOINT`,
     `OAUTH_AUDIENCE` — Auth0 client_credentials for KMS at
     `http://localhost:8180/mcp`.
   - `ANTHROPIC_API_KEY` — Haiku 4.5 distillation step.
   - For slack-huddles only: any creds the live Slack source needs (it falls
     back to `--source file` and a JSON dump when no Slack tools are wired).

A repo-local `.env` will also be sourced if present.
