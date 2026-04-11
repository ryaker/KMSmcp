# KMS MCP — Examples

Drop-in hooks and skills for integrating KMS into your Claude Code workflow.

## hooks/

Claude Code hook scripts that automate KMS saves.

| Hook | Event | What it does |
|------|-------|-------------|
| `kms-precompact.sh` | `PreCompact` | Always saves before context compaction |
| `kms-periodic-checkpoint.sh` | `Stop` | Saves every N exchanges (default: 20) |

See [hooks/README.md](hooks/README.md) for installation.

## skills/

Claude Code skills for manual KMS operations.

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `kms-session-checkpoint` | `/kms-session-checkpoint` | Save current session knowledge to KMS |

Copy a skill folder to `~/.claude/skills/` to install it.
