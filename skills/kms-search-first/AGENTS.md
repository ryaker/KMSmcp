# KMS Search-First (Codex variant)

Codex-flavored mandatory pre-generation reflex: search KMS BEFORE answering from training data when the user references prior context.

## When this protocol applies

Trigger phrases: "remember when", "we discussed", "I previously said", "did I store", "what did I decide about", "didn't we talk about", "I think I told you", "have I mentioned", "we worked on this before", "what's my preference for", "did I already note".

Also fires when:
- User asks a factual question about themselves, their projects, their preferences ("what's my X?", "how do I usually Y?")
- User asks about a project/person/decision they likely have prior context on
- You're about to generate a confident-sounding answer about Rich's preferences/projects/people from training data

Do NOT fire on:
- Pure-recall queries with no follow-up (use `kms-recall`)
- Generic factual questions unrelated to Rich ("what's the syntax for jq?")
- Real-time data ("what time is it?")

## Process

### Step 1 — Search

```
unified_search:
  query: <topic the user referenced>
  filters:
    userId: richard_yaker
    subject: <if a specific facet is implied>
    source: <if a domain is clear>
    minConfidence: 0.6 (optional)
  options:
    maxResults: 10
    includeRelationships: true
```

### Step 2 — Surface results to the user

Briefly. Don't silently absorb. Format:

```
Searched KMS for "<query>":
  • [contentType, confidence%] subject — content preview
  • [contentType, confidence%] subject — content preview

Continuing with your question:
```

Three reasons for surfacing:
- Transparency about what informed the answer
- Correction opportunity if search missed or surfaced stale entries
- Trust calibration — Rich knows it's grounded, not hallucinated

### Step 3 — Proceed

Search is the FIRST step, not the WHOLE step. After surfacing:
- Question → answer using search hits as ground truth
- Extending prior fact → `kms_update` or `kms_supersede` (NEVER additively `unified_store`)
- Pure retrieve → done (this is `kms-recall`'s path)
- Store new related → `unified_store` with `metadata.subject` matching prior entry's subject so they cluster

### Step 4 — Handle no results

If empty or low-confidence (<0.5):
1. Say so explicitly: "I don't have anything stored about [topic] in your KMS."
2. Offer alternatives:
   - "Want me to search related terms? I might have something filed under [adjacent concept]."
   - "Want me to add what we discuss to KMS?"
3. Do NOT fall back to training data and answer as if you had context. Be honest about the gap.

## Why this exists

KMS adoption is bottlenecked by read failures. Every confident-from-training answer about Rich's context is a missed read AND a slow erosion of trust. Search-first cost is ~50ms; confidently-wrong cost is much higher.

## What this protocol does NOT do

- Does NOT replace `kms-recall` for pure-retrieval queries
- Does NOT replace `kms-grounding` for full-context briefings
- Does NOT call any storage tools — only `unified_search`. Storage decisions happen in the follow-on step using `kms-remember` / `kms-auto-capture` / `kms-meeting-synthesis`
- Does NOT search for things unrelated to Rich's context
