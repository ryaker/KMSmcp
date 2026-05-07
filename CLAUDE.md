# KMS Unified MCP - Claude Usage Instructions

## Overview

This unified KMS MCP provides intelligent multi-dimensional memory storage and retrieval across Mem0, SparrowDB (graph), and MongoDB. Unlike siloed tools, this unified interface allows Claude to naturally store and retrieve knowledge that spans multiple datastores simultaneously.

## Core Principle: Multi-Dimensional Memory

Memory is multi-dimensional and multi-modal. Rich information naturally has multiple aspects that benefit from different storage systems:

**Example: "Client responds really well to morning sessions and visualization techniques"**
- **Memory/Preference** (Mem0): Client behavior patterns, personal responses
- **Effectiveness Relationships** (SparrowDB / graph): Morning sessions ↔ Client engagement, Visualization ↔ Technique effectiveness
- **Structured Data** (MongoDB): Session scheduling data, technique metadata, outcome tracking

## Tools Available

### `unified_search` - Search Across All Systems
Search existing knowledge before storing new information:
```json
{
  "query": "client morning sessions visualization",
  "filters": {
    "contentType": ["memory", "insight", "relationship"],
    "userId": "client_123"
  },
  "options": {
    "includeRelationships": true,
    "maxResults": 10
  }
}
```

### `unified_store` - Multi-Dimensional Storage
Store knowledge across multiple systems based on its natural dimensions:
```json
{
  "content": "Client breakthrough with morning visualization techniques",
  "contentType": "insight",
  "source": "coaching",
  "userId": "client_123",
  "relationships": [
    {
      "targetId": "morning-sessions",
      "type": "ENHANCED_BY",
      "strength": 0.9
    }
  ]
}
```

## Making Memory Integration Natural

### 1. Automatic Search Triggers

Develop these as second nature:
- User mentions "remember when..." → **Search first**
- Giving technical advice → **Search for previous solutions**
- User shares preferences/decisions → **Search for related patterns**  
- Something "connects" to prior conversations → **Search for those connections**
- Starting complex problem-solving → **Search existing knowledge**

### 2. Integrated Problem-Solving Flow

**Old flow:** Question → Think → Answer

**New flow:** Question → **Search existing knowledge** → Think + Previous context → Answer + **Store new insights**

### 3. Natural Storage Moments

Store when encountering:
- **Breakthrough moments**: "I finally figured out...", "Aha!", "Now I understand..."
- **Preferences expressed**: "I prefer...", "Works best when...", "I like..."
- **Decisions with reasoning**: "Decided to use X because Y"
- **Patterns discovered**: "Always happens when...", "Consistently see..."
- **Technical solutions**: Bug fixes, configurations, workarounds
- **Relationship insights**: "X connects to Y", "This relates to..."

### 4. Multi-Dimensional Thinking

When storing rich information, consider multiple aspects:

**Technical breakthrough:** "Finally solved OAuth issue by updating JWKS endpoint"
- **Mem0**: Personal breakthrough experience, problem-solving journey
- **SparrowDB (graph)**: OAuth → JWKS → Authentication → Problem solving relationships
- **MongoDB**: Technical solution details, configuration updates, troubleshooting steps

**Client insight:** "Morning meditation helps client focus during difficult conversations"
- **Mem0**: Client behavior pattern, personal response
- **SparrowDB (graph)**: Meditation → Focus → Difficult conversations → Coping strategies
- **MongoDB**: Session notes, timing data, technique effectiveness metrics

### 5. Positive Reinforcement Loop

The more you search and find useful previous knowledge, the more natural it becomes. When stored memories help future conversations, the value becomes clear.

## Correcting Wrong Entries — Use the Corrective Tools, Not Additive Store

**Critical rule**: If you're about to store a fact that contradicts or replaces a previous one, **do not call `unified_store` again**. That additively stores the new one alongside the wrong one, and both leak into context injection on every future session.

KMS has five corrective tools. Pick the right one:

| You want to... | Use | Effect |
|---|---|---|
| Correct a fact you previously stored wrong (the common case) | `kms_supersede(old_id, new_content, reason)` | Atomic: stores new entry with `metadata.supersedes=old_id`, flags old with `flag=SUPERSEDED, superseded_by=new_id`. Both preserved for audit; new one shows in search, old one hidden. Rolls back new if flag fails. |
| Fix a typo / adjust confidence / tweak metadata (same fact, minor edit) | `kms_update(id, content, reason)` | In-place mutation. Bumps timestamp, appends reason to `metadata.update_history`. Not for retraction. |
| Delete noise (test entry, accidental store, garbage — no replacement) | `kms_delete(id, reason)` | Soft-delete: flags `DELETED`. Reversible for 90 days. |
| Mark an entry partially wrong without replacing it | `kms_flag(id, 'RETRACTED' \| 'UNVERIFIED', note)` | Hides from default reads; original content preserved for audit. Pass `flag=null` to un-flag. |
| Clean up old flagged entries past the reversibility window | `kms_reap({olderThanDays: 90, dryRun: true})` | Dry-run by default. Set `dryRun: false` to hard-delete. Admin operation. |

**How this interacts with context injection**: `unified_search` (and the `kms-context-fetch.py` UserPromptSubmit hook that calls it) default-exclude flagged entries. The moment you supersede a wrong fact, it **stops leaking into every future session's context** automatically. Pass `options.includeFlagged: true` to see them (audit/reaper paths only).

**When in doubt, prefer `kms_supersede` over `kms_delete`**. The mistake is data — future you or a future agent might want to trace why a conclusion changed. Supersede preserves the chain; delete is for actual garbage.

**Example correction flow**:
```json
// Wrong fact stored earlier (id returned by unified_store)
// { "id": "abc-123", "content": "Phoenix uses exactly 6 cameras", ... }

// Later discovered to be wrong. Instead of storing a contradicting fact:
kms_supersede({
  "old_id": "abc-123",
  "new_content": "Phoenix camera count is UNKNOWN pending canvas bounds verification. Prior 6-camera claim used wrong zoom config and A-only FOV.",
  "contentType": "insight",
  "reason": "Canvas bounds unverified and R_fold used config 0 not config 2"
})
// Now unified_search returns only the corrected version by default.
```

### How `kms_supersede` actually works (issue #62 fix)

The storage router writes to `graph + mem0` for every entry, but only adds `mongodb` when the content is `procedure` / `source=technical` / matches a structured-content keyword pattern. So an `insight` entry routed to graph+mem0-only does **not** exist in MongoDB at all.

Before issue #62 was fixed, supersede unconditionally required MongoDB.flag to succeed — for graph-only entries this silently failed (entry not in mongo), triggered rollback, and left 4/12 historical chains with orphan `superseded_by` IDs (DG-INV-2 audit).

After the fix, supersede now:
1. Probes each backend with `findById(old_id)` to determine where the entry actually lives.
2. Builds a `requiredBackends` set from the probes (e.g. `[sparrowdb]` for graph-only, `[sparrowdb, mongodb]` for procedure/technical).
3. Flags only those required backends. Backends that don't have the entry are skipped with a debug log, not failed.
4. Succeeds only if **every required backend** flagged successfully. If any required flag fails, rolls back: hard-deletes the new entry and un-flags the partial successes.

**Rare error you may see**: `supersede: old_id <id> not found in any backend (checked: sparrowdb, mongodb). Verify the id is correct.` This means the id is wrong (typo, deleted entry, etc.) — not a routing oddity. Look up the id with `kms_get_memory_by_id` or `unified_search` first.

### Tag high-traffic entries with `metadata.subject` (DG-FACET-A)

For long-running projects (Phoenix, L16, Rich's preferences, etc.), include an explicit `metadata.subject` facet on every `unified_store` call. The subject is a dotted path that names the *specific* fact, not the broad topic — `Phoenix.camera_count`, `L16.distribution_model`, `Rich.preferences.communication_style`. Stored verbatim, no transformation.

Why it matters: subject is a first-class search filter (`unified_search({filters: {subject: "Phoenix.camera_count"}})`) so you can pull the chain of supersedes/updates for one specific fact without scrolling through every entry that mentions Phoenix. The upcoming dedup gate (DG-T1-B) uses subject to scope its similarity check, so subject-tagged entries get cleaner dedup behavior than entries that share only a broad topic.

Naming convention: `Project.fact_name` or `Person.preferences.facet`. Reuse the same subject every time you write about that fact — that's how supersede chains stay queryable.

```json
{
  "content": "Phoenix camera count is 6 per the Mar-2026 calibration session",
  "contentType": "fact",
  "metadata": { "subject": "Phoenix.camera_count" }
}
// Later, search just this fact's chain:
// unified_search({ query: "phoenix cameras", filters: { subject: "Phoenix.camera_count" } })
```

When in doubt, omit subject — pure pass-through, no validation. But for any fact you expect to update or supersede later, set it.

## Dedup Gate (Tier 1 — DG-T1-B)

When you call `unified_store`, the gate may refuse the write if a near-duplicate already exists for the same `userId` + `contentType` + (optional) `metadata.subject`. The response shape:

```json
{
  "status": "dedup_required",
  "candidates": [
    {
      "id": "abc-123",
      "similarity": 0.91,
      "content_preview": "Phoenix camera count is UNKNOWN pending canvas bounds verification...",
      "contentType": "fact",
      "subject": "Phoenix.camera_count",
      "created": "2026-04-13T...",
      "flag": null,
      "llm_relation": null
    }
  ],
  "message": "Likely duplicate found (cos=0.91 >= 0.88). Retry with action.",
  "retry_with": [
    "action=supersede&old_id=abc-123&reason=<...>",
    "action=update&old_id=abc-123&reason=<...>",
    "action=complement&related_to=abc-123",
    "action=force-new&reason=<justification>"
  ],
  "band": "refuse",
  "thresholds": { "refuse": 0.88, "confirm": 0.78 }
}
```

If you receive `dedup_required`, **choose ONE retry action**: `supersede`, `update`, `complement`, or `force-new`. Each requires a `reason` (except `complement`, which uses `related_to`). Do NOT just retry the original write — the gate will refuse again.

**Thresholds (calibrated empirically against the real KMS corpus by DG-INV-2):**
- `>= 0.88` (refuse band): likely duplicate — must choose explicit action
- `0.78 – 0.88` (confirm band): borderline — must choose explicit action
- `< 0.78`: distinct, proceeds normally

Per-contentType overrides:
- `procedure` → refuse threshold = 0.85 (refutation rewrites cluster lower)
- `pattern` → refuse threshold = 0.92 (duplicates extremely tight)

**DG-T1-C dispatch is not yet wired** (issue #46). For now, when the gate returns `dedup_required` you should manually call `kms_supersede(old_id, new_content, reason)` (or `kms_update`, `kms_delete`, etc.) using the candidate ID from the response. The `action=…` field will be honored as the dispatch shortcut once DG-T1-C lands; until then, passing `action` simply bypasses the gate and proceeds to a normal `unified_store`.

**The gate uses `metadata.subject` as a scope filter when present.** Two writes with the same `subject` get the tightest dedup check (narrowed to that facet of that topic). When you omit `subject`, the gate falls back to `userId + contentType` only — so writes without a subject still trigger dedup against any same-userId-same-contentType entry, not zero matches. Tag high-traffic facts with explicit `metadata.subject` (see preceding section) to scope the dedup check tighter and avoid false positives across unrelated facets of the same topic.

**Known limitation (upstream)**: As of sparrowdb 0.1.22, the Node.js binding does NOT expose parameter-binding for `execute()` (no `execute_with_params`), and the Cypher parser rejects list literals in `SET` / `CREATE`. This means `storeEmbedding`'s `SET k.embedding = [...]` write path silently fails — the HNSW index stays empty, and the dedup gate is inert in practice (it always finds 0 candidates and proceeds to a normal store). The gate logic, type guards, and threshold dispatch are all correct and will activate the moment the upstream binding gains either (a) `execute_with_params` for vector inserts, or (b) parser support for f32-list literals in SET. Tracked separately from DG-T1-B.

## Best Practices

### Search First, Store Smart
1. Always search before storing to avoid duplicates
2. Use search results to inform storage decisions
3. Build on existing knowledge rather than creating isolated memories
4. **If search returns a fact you're about to contradict, use `kms_supersede`, not `unified_store`**

### Natural Language Processing
- Use natural descriptions in storage
- Let the MCP handle technical routing decisions
- Focus on the conceptual connections and meaning

### Context Awareness
- Include user context when available
- Reference related concepts and relationships
- Consider temporal aspects (when did this happen/matter)

### Multi-Dimensional Storage
```json
{
  "content": "User prefers async communication over real-time meetings",
  "contentType": "preference", 
  "source": "personal",
  "userId": "user_123",
  "metadata": {
    "communication_style": "asynchronous",
    "meeting_preference": "scheduled",
    "context": "work_efficiency"
  },
  "relationships": [
    {
      "targetId": "communication-preferences",
      "type": "INSTANCE_OF",
      "strength": 0.9
    },
    {
      "targetId": "productivity-patterns", 
      "type": "RELATES_TO",
      "strength": 0.7
    }
  ]
}
```

## Datastore Strengths

**Mem0**: Personal experiences, preferences, episodic memories, user behavior patterns
**SparrowDB (graph)**: Concept relationships, technique effectiveness, causal connections, knowledge graphs (embedded; replaced Neo4j Aura in the SparrowDB cutover — `storage.graph` slot, `storageDecision.primary: "graph"`)
**MongoDB**: Structured data, configurations, session notes, quantitative tracking

## Implementation Goals

Make memory integration so smooth and natural that it becomes automatic - like how you naturally break down complex problems or connect related concepts. The unified MCP handles the technical complexity while you focus on the conceptual richness of multi-dimensional memory.
## 🔍 SemTools - Semantic Filesystem for Document Intelligence

### Overview
SemTools provides semantic search and document parsing capabilities, transforming Claude Code into a general document intelligence agent beyond just code.

### Components
- **`parse`** - Converts non-searchable documents (PDFs, DOCX, PPTX, etc.) to markdown using LlamaParse API
- **`search`** - Local semantic keyword search using multilingual embeddings (no cloud dependency)
- **`workspace`** - Persistent caching for blazing-fast repeated searches

### Installation & Configuration
```bash
# Already installed globally via npm
# API key configured in ~/.zshrc (NEVER commit actual keys to git!)
export LLAMA_CLOUD_API_KEY="<your-llama-cloud-api-key>"
```

### Common Usage Patterns

#### Basic Parse and Search
```bash
# Parse PDFs and search for specific content
parse document.pdf | xargs cat | search "error handling" --n-lines 30

# Search across multiple parsed documents
parse my_docs/*.pdf | xargs search "API endpoints" --n-lines 30 --max-distance 0.3

# Direct search on text files
search "machine learning" *.txt --n-lines 30 --top-k 10
```

#### Using Workspaces for Large Collections
```bash
# Create/use a workspace for persistent indexing
workspace use my-workspace
export SEMTOOLS_WORKSPACE=my-workspace

# Initial search (creates index)
search "financial analysis" docs/*.pdf --n-lines 30 --top-k 10

# Subsequent searches use cached embeddings (MUCH faster)
search "quarterly earnings" docs/*.pdf --n-lines 30 --max-distance 0.3

# Check workspace status
workspace status

# Clean up stale files
workspace prune
```

#### Advanced Pipelines
```bash
# Combine with grep for precise filtering
parse *.pdf | xargs cat | grep -i "revenue" | search "Q3 2024" --max-distance 0.2

# Multi-stage pipeline
find . -name "*.pdf" -mtime -30 | xargs parse | xargs search "compliance" --n-lines 50

# Parse and create searchable knowledge base
parse reports/*.pdf contracts/*.docx | tee parsed_files.txt | xargs search "liability clause" --n-lines 40
```

### Best Practices for Claude Code

1. **Always use workspaces** for repeated searches over the same files
2. **Set --n-lines to 30-50** for adequate context (default 3 is too small)
3. **Use --ignore-case** flag for case-insensitive search
4. **Parse first** when dealing with PDFs, Word docs, or other non-text formats
5. **Combine --max-distance and --top-k** for optimal results
6. **Cache parsed files** - they're stored in ~/.parse/ automatically

### Use Cases

- **Financial Analysis**: Parse quarterly reports, search for specific metrics
- **Legal Review**: Search contracts for specific clauses semantically
- **Research Synthesis**: Analyze academic papers, extract methodologies
- **Technical Documentation**: Find info across mixed format docs
- **Knowledge Mining**: Create searchable indexes of company documents

### Tips

- Parsed files are cached in `~/.parse/` - reuse them!
- Workspaces are stored in `~/.semtools/workspaces/`
- Use `--max-distance 0.3` for semantic similarity (lower = more similar)
- Use `--top-k` when you want a fixed number of results
- Combine with standard Unix tools (grep, awk, sed) for powerful pipelines

