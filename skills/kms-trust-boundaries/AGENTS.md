# KMS Trust Boundaries (Codex variant)

Codex-flavored corpus trust enforcement for L16/Lumen/libcp work. Codifies KMS memory `54f04f28-259e-4c8c-9f6e-64cefc8fff52`.

## When this protocol applies

Fires on:
- ANY file operation (Read, Grep, ingest, cite, summarize) where path matches `Light_*`
- ANY claim about Lumen, libcp, L16, or related reverse-engineering topics where source provenance matters
- User asks "is this verified" / "can I trust this source" / "is this canonical"
- About to call `unified_store` with content from an UNTRUSTED path
- About to cite a fact in an answer where source is UNTRUSTED

Does NOT fire on:
- Generic file ops on unrelated directories
- Citation of L16 facts where source is the TRUSTED `L16_Lumen_ReverseEngineering` repo
- Quoting Rich-authored notes in `~/Documents/Notes/` (case-by-case, neither blanket-trusted nor blanket-untrusted)

## Trust matrix

| Path | Trust | Meaning |
|---|---|---|
| `/Users/ryaker/Dev/L16_Lumen_ReverseEngineering/` | TRUSTED | Codex-curated canonical source. Cite freely. Ingest into KMS as `fact`/`procedure`. |
| `~/Documents/Light_Work/` (and `Light_*` siblings) | UNTRUSTED | Working drafts, AI output, scratch notes, unverified external content. Do NOT cite as fact. Do NOT ingest into KMS without explicit user override. |

Path-name pattern matters: `Light_Work` and `L16_Lumen_ReverseEngineering` look similar, opposite trust. A future `Light_Lumen_v2/` would be UNTRUSTED until Rich explicitly promotes it.

## Behavioral rules

### Rule 1: reading allowed; citing constrained

You MAY read UNTRUSTED files — they often contain context Rich wants you to consider. Citing them as fact is what's constrained.

When citing UNTRUSTED content:
- Prefix `[unverified]` in the answer
- Name source path explicitly
- If TRUSTED counterpart exists in `L16_Lumen_ReverseEngineering`, prefer it
- If conflict between UNTRUSTED claim and TRUSTED L16 repo, surface BOTH and recommend the L16 version

### Rule 2: no UNTRUSTED → KMS without explicit override

Before `unified_store` from a `Light_*` path:
1. STOP. Tell Rich: "This content is from an UNTRUSTED path (`<path>`). Ingesting into KMS would promote it to fact-status."
2. Ask: "Do you want me to (a) ingest with `metadata.trust=unverified`, (b) verify against L16 repo first, or (c) skip the ingest?"
3. Wait for explicit approval. Default to (c) skip.

If approved:
- Always include `metadata.trust: "unverified"` and `metadata.source_path: "<full path>"`
- Always include `metadata.subject` for future supersede-ability
- Strongly consider `contentType: pattern` or flag `'UNVERIFIED'` instead of `fact`/`insight`

### Rule 3: prefer TRUSTED source for any Lumen/libcp/L16 claim

When generating answers involving Lumen, libcp, or L16:
1. Check `L16_Lumen_ReverseEngineering` first
2. If user-cited material conflicts with L16 repo, surface conflict — don't silently pick
3. KMS entries with `metadata.subject = L16.*` older than 30 days should be checked against the L16 repo (repo is moving canonical, KMS entries are point-in-time captures)

### Rule 4: verify-before-trust extends to path heuristics

Same path-name pattern, opposite trust levels. When in doubt about a new directory's trust level, ASK before treating it as canonical.

## Operational checklist

Before any write that could touch the L16/Lumen knowledge boundary:

- [ ] Source path identified
- [ ] Trust level determined (TRUSTED / UNTRUSTED / project-specific)
- [ ] If UNTRUSTED: did Rich explicitly approve KMS ingest?
- [ ] If citing: is `[unverified]` prefix present for UNTRUSTED sources?
- [ ] If conflict with L16 repo: surfaced explicitly to Rich?
- [ ] Subject facet set for future supersede-ability?

## Cross-reference

- Canonical write-up: KMS memory `54f04f28-259e-4c8c-9f6e-64cefc8fff52`
- L16 repo: `/Users/ryaker/Dev/L16_Lumen_ReverseEngineering/`
- Untrusted scratch: `~/Documents/Light_Work/` and `Light_*` siblings
- Always check KMS first: `kms-search-first`
- Meeting transcripts of L16 review meetings are TRUSTED, ingest with `subject: L16.*`: `kms-meeting-synthesis`
- When wrong fact leaked through: `kms_supersede` with reason citing this skill's Rule 2 violation
