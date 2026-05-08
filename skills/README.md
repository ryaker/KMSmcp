# KMSmcp Skills Layer

Portable behavioral protocols for Richard's Personal KMS — deployable across Claude Code, Cowork (Claude Desktop), claude.ai (web + iOS), and Codex CLI. Codifies the **OB1 Pattern 1 outer-loop model** lifted from `~/Documents/Notes/OB1-Lessons-vs-KMS-Direction.md`: KMSmcp stays the dumb storage primitive; curation policy moves into portable skills that work in any client where Rich talks to Claude.

**Why this exists**: The behavioral patterns in `/Users/ryaker/Dev/KMSmcp/CLAUDE.md` only fire in Claude Code on the Mac mini. Rich uses 4+ Claude clients, and the KMS MCP at `https://kms.yaker.org` is reachable from all of them. These skills make the patterns portable so EVERY client treats KMS consistently.

## The Five Skills

| Skill | What it does | Trigger phrases |
|---|---|---|
| [kms-auto-capture](./kms-auto-capture/) | Distills session-end into atomic KMS entries. Search-first; `metadata.subject` required; routes contradictions through `kms_supersede`. | "wrap up", "park this", "checkpoint", "before I forget" |
| [kms-meeting-synthesis](./kms-meeting-synthesis/) | Ingests a meeting transcript / Granola note / Slack huddle into one whole-meeting summary + 2-5 typed atomic claims linked back via `metadata.related_to`. | "summarize this meeting", "ingest this Granola", "process this huddle" |
| [kms-reconcile-pass](./kms-reconcile-pass/) | Full-reconciliation outer loop. Loads a topic cluster, identifies contradictions / near-duplicates / orphan chains, **proposes** corrective actions for human approval before dispatching. | "reconcile KMS", "audit KMS for <topic>", "weekly KMS pass" |
| [kms-search-first](./kms-search-first/) | Mandatory pre-generation reflex. Calls `unified_search` BEFORE answering when user references prior context. Surfaces results, then proceeds. | "remember when", "we discussed", "did I store" |
| [kms-trust-boundaries](./kms-trust-boundaries/) | Enforces L16/Lumen/libcp corpus trust boundaries. UNTRUSTED `Light_*` paths require `[unverified]` citation and explicit approval before KMS ingest. TRUSTED `L16_Lumen_ReverseEngineering` repo wins on conflict. | Any operation against `Light_*` paths or L16/Lumen claims |

## Where the Skills Fit

- **Write-time prevention**: dedup gate (Tier 1) — automatic on `unified_store`, server-side
- **Pre-generation read enforcement**: `kms-search-first` ← skill layer
- **Capture distillation**: `kms-auto-capture`, `kms-meeting-synthesis` ← skill layer
- **Background reconciliation**: `kms-reconcile-pass` ← skill layer (OB1 Pattern 1's missing half)
- **Source provenance enforcement**: `kms-trust-boundaries` ← skill layer
- **Hard cleanup of flagged entries past 90-day window**: `kms_reap` (admin tool, not a skill)

## Unified Install Matrix

| Client | Install | Notes |
|---|---|---|
| **Claude Code** (personal, all projects) | Copy `SKILL.md` to `~/.claude/skills/<name>/SKILL.md` | Live change detection picks it up — no restart |
| **Claude Code** (project scope, KMSmcp only) | Symlink `skills/<name>` into `.claude/skills/` | Already in place if you symlink; auto-loads |
| **Cowork** (Claude Desktop) | `/plugin marketplace add ryaker/KMSmcp` then `/plugin install kms-skills@ryaker/KMSmcp` | Requires marketplace publish (see status below) |
| **claude.ai web Project** | Paste `SKILL.md` body (post-frontmatter) into Project's Custom instructions | Connector setup separate (see below) |
| **iOS Claude** | Automatic via claude.ai web Project | Same backend |
| **Codex CLI** | Copy `AGENTS.md` to project root or `~/AGENTS.md` | Codex resolves closest one |

## One-Line Install Examples

### Claude Code — install all 5 skills personally
```bash
SKILLS_SRC=/Users/ryaker/Dev/KMSmcp/skills
for s in kms-auto-capture kms-meeting-synthesis kms-reconcile-pass kms-search-first kms-trust-boundaries; do
  mkdir -p ~/.claude/skills/$s
  cp $SKILLS_SRC/$s/SKILL.md ~/.claude/skills/$s/SKILL.md
done
```

### Claude Code — symlink at project scope (so skills track repo updates)
```bash
SKILLS_SRC=/Users/ryaker/Dev/KMSmcp/skills
mkdir -p /Users/ryaker/Dev/KMSmcp/.claude/skills
for s in kms-auto-capture kms-meeting-synthesis kms-reconcile-pass kms-search-first kms-trust-boundaries; do
  ln -sfn $SKILLS_SRC/$s /Users/ryaker/Dev/KMSmcp/.claude/skills/$s
done
```

### Cowork — install bundled plugin (when marketplace is published)
```
/plugin marketplace add ryaker/KMSmcp
/plugin install kms-skills@ryaker/KMSmcp
```

### claude.ai web Project — manual paste
Open the Project, navigate to Custom instructions, paste the post-frontmatter body of each `SKILL.md`. (Frontmatter doesn't apply on claude.ai — only the markdown body matters there.)

### Codex CLI — copy AGENTS.md to project root
```bash
cp /Users/ryaker/Dev/KMSmcp/skills/<skill-name>/AGENTS.md /path/to/project/AGENTS.md
# Or for global Codex behavior:
cp /Users/ryaker/Dev/KMSmcp/skills/<skill-name>/AGENTS.md ~/AGENTS.md
```

If a target already has an `AGENTS.md`, append rather than overwrite:
```bash
cat /Users/ryaker/Dev/KMSmcp/skills/<skill-name>/AGENTS.md >> /path/to/AGENTS.md
```

## MCP Connector Setup

These skills are **behavioral protocols** — they call KMSmcp tools (`unified_store`, `unified_search`, `kms_supersede`, `kms_update`, `kms_delete`, `kms_flag`, `kms_reap`) but the skills themselves do not configure connectivity.

The KMS MCP must be reachable from the client:

| Client | Connector setup |
|---|---|
| Claude Code (Mac mini) | Already in place via local stdio config |
| Cowork (Claude Desktop) | Add MCP at `https://kms.yaker.org/mcp` in Cowork's MCP config |
| claude.ai web Project | Add MCP at `https://kms.yaker.org/mcp` in Project's MCP connectors |
| iOS Claude | Inherits from claude.ai web Project |
| Codex CLI | Configure in Codex's MCP server config (varies by version — check `codex --help` or docs) |

Once the MCP is connected, the tool names are stable across clients (`unified_store`, `unified_search`, `kms_supersede`, etc.) — these skills reference them by canonical name.

## Marketplace Publishing Status

The Cowork plugin manifest (`skills/.claude-plugin/plugin.json`) is in place, but **the plugin has NOT been published to a marketplace.** Publishing to the official Anthropic marketplace requires submission via `claude.ai/settings/plugins/submit`, which is a separate authorization gate Rich hasn't approved.

Until then, install via:
- **Claude Code**: per-skill copy or symlink (works today)
- **Cowork**: manual copy of `SKILL.md` files into Cowork's skill directory (location varies by version)
- **claude.ai / iOS**: paste body into Project's Custom instructions (works today)
- **Codex**: copy `AGENTS.md` (works today)

## Conventions Across All Skills

All skills share these invariants:

- **`userId: richard_yaker`** — every KMS call is scoped to Rich's data
- **`metadata.subject`** — every store includes a dotted-path facet (e.g., `Phoenix.camera_count`, `Rich.preferences.communication_style`) when the fact is one Rich expects to update or supersede later
- **Search before store** — every skill searches first to avoid duplicates
- **Supersede over re-store** — contradicting facts use `kms_supersede`, never additive `unified_store`
- **`dedup_required` is structural** — every skill handles the gate's refusal with explicit retry actions (`supersede` / `update` / `complement` / `force-new`), never blind retry

## Cross-Reference

- KMSmcp tool reference: `/Users/ryaker/Dev/KMSmcp/CLAUDE.md`
- OB1 Pattern 1 design study: `/Users/ryaker/Documents/Notes/OB1-Lessons-vs-KMS-Direction.md`
- Dedup gate spec: `/Users/ryaker/Documents/Notes/KMS-Semantic-Dedup-Gate-Spec.md`
- Existing complementary skills (also in `~/.claude/skills/`): `kms-remember`, `kms-recall`, `kms-grounding`
- Trust-boundaries canonical write-up: KMS memory `54f04f28-259e-4c8c-9f6e-64cefc8fff52`
