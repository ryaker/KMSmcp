# kms-auto-capture

Behavioral protocol that fires at session-end (or natural close) and distills the session into atomic, self-contained KMS entries via `unified_store`. Always searches first, never additively re-stores contradicting facts (uses `kms_supersede`), and tags every entry with `metadata.subject`.

See [SKILL.md](./SKILL.md) for the full protocol. See [AGENTS.md](./AGENTS.md) for the Codex-flavored variant.

## What it does

- Detects session-end cues in user input ("wrap up", "park this", "checkpoint", etc.)
- Scans the session for novel, atomic, self-contained items
- Searches KMS first to avoid duplicates
- Stores each item with `unified_store`, including `metadata.subject` (REQUIRED)
- Routes contradictions through `kms_supersede` instead of additive store
- Handles `dedup_required` responses with explicit retry actions
- Reports a clean summary of what was captured / skipped / superseded

## Install

The KMS MCP must be reachable for this skill to do anything. Connector setup at `https://kms.yaker.org/mcp` is separate (see top-level [skills/README.md](../README.md#mcp-connector-setup)).

### Claude Code (personal scope, all projects)

```bash
mkdir -p ~/.claude/skills/kms-auto-capture
cp /Users/ryaker/Dev/KMSmcp/skills/kms-auto-capture/SKILL.md ~/.claude/skills/kms-auto-capture/SKILL.md
```

Live change detection picks it up within the current session — no restart needed.

### Claude Code (project scope, KMSmcp repo only)

Already in place at `.claude/skills/kms-auto-capture/SKILL.md` if you symlink:
```bash
mkdir -p /Users/ryaker/Dev/KMSmcp/.claude/skills
ln -sf /Users/ryaker/Dev/KMSmcp/skills/kms-auto-capture /Users/ryaker/Dev/KMSmcp/.claude/skills/kms-auto-capture
```

### Cowork (Claude Desktop)

Install the bundled `kms-skills` plugin (installs all 5 skills at once):
```
/plugin marketplace add ryaker/KMSmcp
/plugin install kms-skills@ryaker/KMSmcp
```

Note: this requires the marketplace publishing flow Rich hasn't authorized yet. Until then, manually copy `SKILL.md` into Cowork's skill directory (location varies by Cowork version — check Cowork's settings panel).

### claude.ai web Project

1. Open the relevant Project (or create one for KMS work)
2. Project Settings → Custom instructions
3. Paste the BODY of `SKILL.md` (everything after the closing `---` of frontmatter — markdown only). Frontmatter doesn't apply on claude.ai.
4. Ensure the KMS MCP connector is configured for the Project at https://kms.yaker.org/mcp

### iOS Claude

Automatic via the claude.ai web Project — iOS uses the same backend. No separate install.

### Codex CLI

Codex reads `AGENTS.md` files in the working directory tree. Two install paths:

**Per-project**: Copy `AGENTS.md` into the project root where you want this behavior:
```bash
cp /Users/ryaker/Dev/KMSmcp/skills/kms-auto-capture/AGENTS.md /path/to/project/AGENTS.md
```

If the project already has an `AGENTS.md`, append the contents instead of overwriting:
```bash
cat /Users/ryaker/Dev/KMSmcp/skills/kms-auto-capture/AGENTS.md >> /path/to/project/AGENTS.md
```

**Global**: Place at `~/AGENTS.md` so all Codex sessions see it (Codex resolves the closest one in the directory tree, falling back upward).

## Verifying Install

In any client with the KMS MCP connected, type:
> "checkpoint to KMS"

The skill should fire and start the search-first → store loop. If nothing happens, the skill isn't loaded — re-check the install path.

## Trigger Phrases (Reference)

`wrap up`, `park this`, `let's stop here`, `call it`, `we're done for today`, `goodnight`, `sign off`, `checkpoint`, `save state`, `before I forget`
