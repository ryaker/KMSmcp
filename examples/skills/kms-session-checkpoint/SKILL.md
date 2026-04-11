---
name: kms-session-checkpoint
description: Save key session knowledge to KMS (unified_store). Use when finishing a work session, before a long break, or when context is getting heavy. Extracts decisions, technical facts, patterns, and procedures from the current session and stores them with proper contentType and relationships.
allowed-tools: Bash
---

# KMS Session Checkpoint

Save the key knowledge from this session to the KMS before ending or switching context.

## What to save

Review the conversation and extract items worth keeping in future sessions:

| What | contentType | Notes |
|------|-------------|-------|
| Decisions and why | `insight` | Include the reasoning, not just the outcome |
| Technical facts learned | `fact` | Bugs found, configs that work, root causes |
| Corrections Rich gave | `pattern` | Use verbatim quote where possible |
| Procedures that worked | `procedure` | Step-by-step sequences |

Skip anything ephemeral (specific file line numbers, temporary debug output) or already in KMS.

## How to store

Call the KMS MCP `unified_store` tool for each item:

```json
{
  "content": "SparrowDBStorage now tries npm 'sparrowdb' package first, falls back to local dev build paths",
  "contentType": "fact",
  "source": "technical",
  "userId": "richard_yaker",
  "confidence": 0.9,
  "relationships": [
    { "targetId": "sparrowdb", "type": "RELATES_TO", "strength": 0.9 },
    { "targetId": "KMSmcp", "type": "PART_OF", "strength": 0.8 }
  ]
}
```

## Relationship guidance

Add `relationships` when the item connects to known entities:
- Architecture choices → `PART_OF` the relevant project
- Bug fixes → `FIXES` the problem entity
- Patterns → `APPLIES_TO` the workflow or project
- Decisions → `SUPERSEDES` the previous approach if replacing something

## After saving

Confirm what was saved with a brief summary: N items stored, categories used.
