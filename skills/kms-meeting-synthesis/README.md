# kms-meeting-synthesis

Behavioral protocol for ingesting a meeting transcript / Granola note / Slack huddle recap / call summary into KMS as one whole-meeting summary entry plus 2-5 typed atomic claims. Each claim is linked back to the meeting via `metadata.related_to`.

See [SKILL.md](./SKILL.md) for the full protocol. See [AGENTS.md](./AGENTS.md) for the Codex-flavored variant.

## What it does

- Triggers when handed a Granola URL, Slack canvas, transcript file, or asked to "summarize this meeting"
- Extracts metadata (date, attendees, topic, source URI)
- Searches KMS for prior related meetings before storing
- Generates ONE whole-meeting summary entry (`contentType=memory`, 150-300 words)
- Generates 2-5 typed atomic claims, each with `metadata.related_to: [meeting_id]`
- Each claim has its own `metadata.subject` for future supersede-ability
- Handles `dedup_required` with `action=complement` for recurring-meeting series

This is the in-conversation companion to the cron-driven Granola importer at `src/scripts/import-granola.ts` (PR #74) — same contract, agent-driven instead of batch.

## Install

Same matrix as all KMS skills. Replace `<skill>` with `kms-meeting-synthesis`.

### Claude Code (personal)
```bash
mkdir -p ~/.claude/skills/kms-meeting-synthesis
cp /Users/ryaker/Dev/KMSmcp/skills/kms-meeting-synthesis/SKILL.md ~/.claude/skills/kms-meeting-synthesis/SKILL.md
```

### Claude Code (project)
```bash
ln -sf /Users/ryaker/Dev/KMSmcp/skills/kms-meeting-synthesis /Users/ryaker/Dev/KMSmcp/.claude/skills/kms-meeting-synthesis
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
cp /Users/ryaker/Dev/KMSmcp/skills/kms-meeting-synthesis/AGENTS.md /path/to/project/AGENTS.md
```

## Verifying Install

Hand the agent a Granola URL or transcript and ask "summarize this meeting and store it in KMS." The skill should fire and produce a whole-meeting entry + 2-5 linked claims.

## Trigger Phrases (Reference)

`summarize this meeting`, `extract action items`, `what did we decide`, `draft the follow-up`, `ingest this Granola`, `process this huddle`, `log this call`, `store these meeting notes`
