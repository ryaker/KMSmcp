# kms-reconcile-pass

Full-reconciliation behavioral protocol — runs on demand or weekly to drain accumulated dedup debt (contradictions, near-duplicates, orphan supersede chains, stale facts) within a topic cluster. **Never silently applies corrections** — always proposes for human approval first.

See [SKILL.md](./SKILL.md) for the full protocol. See [AGENTS.md](./AGENTS.md) for the Codex-flavored variant.

## What it does

- Triggers on "reconcile KMS", "clean up <topic>", "audit KMS for <subject>"
- Loads a topic cluster via `unified_search` with `subject` filter and `includeFlagged: true`
- Categorizes each entry: canonical / clean-superseded-chain / orphan-chain / contradiction / near-duplicate / stale / garbage
- Generates a structured proposal (supersede X, update Y, delete Z) with rationale
- Waits for explicit user approval (per-item or "approve all")
- Dispatches via `kms_supersede` / `kms_update` / `kms_delete` / `kms_flag`
- Verifies and reports

This is the missing half of the OB1 Pattern 1 lift (full reconciliation as outer-loop skill, complementary to write-time dedup gate).

## Install

### Claude Code (personal)
```bash
mkdir -p ~/.claude/skills/kms-reconcile-pass
cp /Users/ryaker/Dev/KMSmcp/skills/kms-reconcile-pass/SKILL.md ~/.claude/skills/kms-reconcile-pass/SKILL.md
```

### Claude Code (project)
```bash
ln -sf /Users/ryaker/Dev/KMSmcp/skills/kms-reconcile-pass /Users/ryaker/Dev/KMSmcp/.claude/skills/kms-reconcile-pass
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
cp /Users/ryaker/Dev/KMSmcp/skills/kms-reconcile-pass/AGENTS.md /path/to/project/AGENTS.md
```

## Recommended Frequency

- **Weekly**: Run a reconcile pass on the top 1-3 highest-write subjects from the past week
- **On-demand**: When you notice a topic has accumulated drift (e.g., 3+ stores about the same fact in different sessions)
- **Never after every session** — over-fitting; the corpus needs accumulated drift before reconciliation finds signal

Heuristic: `kms_get_kms_analytics` showing >20 writes since the last reconcile pass for a given subject = candidate.

## Verifying Install

Type: "reconcile KMS for Phoenix" — the skill should load the cluster and produce a proposal without applying anything until you approve.

## Safety Notes

- This skill MUST NOT silently apply corrections. If it does, the implementation is broken — file a bug.
- Always scoped to a cluster (subject / topic / contentType), never the full KMS
- Always `userId: richard_yaker` — does not touch other users' data
- Does not call `kms_reap` (that's a separate admin operation)

## Trigger Phrases (Reference)

`reconcile KMS`, `clean up KMS`, `audit KMS for <topic>`, `weekly KMS pass`, `find contradictions in KMS`, `drain KMS dedup debt`, `reconcile <topic>`
