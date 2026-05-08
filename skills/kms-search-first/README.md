# kms-search-first

The codification of "search before generating" as a portable behavioral skill. Triggers whenever the user references prior conversation, prior decisions, prior preferences — calls `unified_search` FIRST, surfaces results, THEN proceeds.

See [SKILL.md](./SKILL.md) for the full protocol. See [AGENTS.md](./AGENTS.md) for the Codex-flavored variant.

## What it does

- Triggers on "remember when", "we discussed", "I previously said", "did I store", "what did I decide about", and other prior-context references
- Calls `unified_search` BEFORE generating an answer — never after
- Surfaces the search results to the user transparently (3-line bulleted summary)
- Then proceeds with whatever the user actually wanted (extending / retrieving / storing related)
- Honest about gaps: if search returns empty, says so explicitly instead of falling back to training-data generation

This is intentionally minimal — most of the work is making sure search happens FIRST instead of as a fallback. Short skill, big behavioral shift.

## Install

### Claude Code (personal)
```bash
mkdir -p ~/.claude/skills/kms-search-first
cp /Users/ryaker/Dev/KMSmcp/skills/kms-search-first/SKILL.md ~/.claude/skills/kms-search-first/SKILL.md
```

### Claude Code (project)
```bash
ln -sf /Users/ryaker/Dev/KMSmcp/skills/kms-search-first /Users/ryaker/Dev/KMSmcp/.claude/skills/kms-search-first
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
cp /Users/ryaker/Dev/KMSmcp/skills/kms-search-first/AGENTS.md /path/to/project/AGENTS.md
```

## Verifying Install

Type something that references prior context, e.g.:
> "remember when we discussed the Phoenix camera count?"

The agent should:
1. Call `unified_search` with "Phoenix camera count" + filter `userId: richard_yaker`
2. Surface results in a bulleted list
3. Then answer your question

If it generates an answer without searching first, the skill isn't loaded.

## Distinction from kms-recall

| Skill | When |
|---|---|
| `kms-recall` | Pure retrieval query — user asks "what do I know about X" and wants a search-and-present answer, no follow-up action |
| `kms-search-first` | User references prior context AND wants follow-up action (extend, store, use as ground truth for next answer) |
| `kms-grounding` | User wants a synthesized briefing on a topic before working on it (more synthesis-heavy than retrieval-heavy) |

Both `kms-recall` and `kms-search-first` call `unified_search`. The difference is what happens AFTER — search-first chains into the next task; recall ends after presentation.

## Trigger Phrases (Reference)

`remember when`, `we discussed`, `I previously said`, `did I store`, `what did I decide about`, `didn't we talk about`, `I think I told you`, `have I mentioned`, `we worked on this before`, `what's my preference for`, `did I already note`
