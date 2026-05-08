# kms-trust-boundaries

Enforces corpus trust boundaries when reading, citing, or ingesting any document for Lumen / libcp / L16 reverse-engineering work. Codifies KMS memory `54f04f28-259e-4c8c-9f6e-64cefc8fff52` as a portable behavioral skill.

See [SKILL.md](./SKILL.md) for the full protocol. See [AGENTS.md](./AGENTS.md) for the Codex-flavored variant.

## What it does

- Recognizes path-name trust levels:
  - `~/Dev/L16_Lumen_ReverseEngineering/` → **TRUSTED** (canonical L16 source)
  - `~/Documents/Light_Work/` (and `Light_*` siblings) → **UNTRUSTED** (drafts, AI output, scratch)
- Allows reading UNTRUSTED files but constrains citation: prefix `[unverified]` and name source path
- Refuses to ingest UNTRUSTED content into KMS without explicit user override
- Surfaces conflicts when UNTRUSTED claims contradict the L16 canonical repo
- Verify-before-trust extends to path-name heuristics (similar names ≠ similar trust)

## Install

### Claude Code (personal)
```bash
mkdir -p ~/.claude/skills/kms-trust-boundaries
cp /Users/ryaker/Dev/KMSmcp/skills/kms-trust-boundaries/SKILL.md ~/.claude/skills/kms-trust-boundaries/SKILL.md
```

### Claude Code (project)
```bash
ln -sf /Users/ryaker/Dev/KMSmcp/skills/kms-trust-boundaries /Users/ryaker/Dev/KMSmcp/.claude/skills/kms-trust-boundaries
```

### Cowork
```
/plugin marketplace add ryaker/KMSmcp
/plugin install kms-skills@ryaker/KMSmcp
```

### claude.ai web Project
Paste body of `SKILL.md` (post-frontmatter) into Project's Custom instructions.

### iOS
Automatic via claude.ai Project.

### Codex CLI
```bash
cp /Users/ryaker/Dev/KMSmcp/skills/kms-trust-boundaries/AGENTS.md /path/to/project/AGENTS.md
```

## Verifying Install

Ask the agent to "ingest the contents of `~/Documents/Light_Work/<some-file>.md` into KMS." The skill should:
1. Detect the path is UNTRUSTED
2. STOP and tell you it would promote the content to fact-status
3. Ask if you want to (a) ingest with `metadata.trust=unverified`, (b) verify against L16 repo first, or (c) skip
4. Default to (c) skip if no answer

If the agent silently ingests, the skill isn't loaded.

## Why This Exists

In prior sessions, AI-generated speculation in `Light_Work/` got cited as fact and ingested into KMS, where it then leaked into every future session's context injection. Once a wrong "Phoenix uses 6 cameras" entry is in the corpus, every search that touches Phoenix surfaces it. This skill prevents the input-side of that failure mode.

The complementary write-time enforcement is the dedup gate (refuses near-duplicates). The complementary correction tool is `kms_supersede` (cleans up wrong facts that already leaked). This skill is the prevention layer.

## Trigger Phrases (Reference)

`is this verified`, `can I trust this source`, `is this canonical`, `should I cite this`, `ingest this into KMS` (when source is `Light_*`), and any operation against paths matching the trust matrix.

## Cross-Reference

- Canonical write-up: KMS memory `54f04f28-259e-4c8c-9f6e-64cefc8fff52`
- L16 repo: `/Users/ryaker/Dev/L16_Lumen_ReverseEngineering/`
- Untrusted scratch space: `~/Documents/Light_Work/` (and `Light_*` siblings)
