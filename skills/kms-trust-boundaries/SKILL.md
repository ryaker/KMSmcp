---
name: kms-trust-boundaries
description: >
  Enforce corpus trust boundaries when reading, citing, or ingesting any document
  for Richard's projects — especially Lumen / libcp / L16 reverse-engineering work.
  Triggers when working with files under ~/Documents/Light_Work/ (UNTRUSTED),
  ~/Dev/L16_Lumen_ReverseEngineering/ (TRUSTED), or any L16/Lumen/libcp claim.
  Also triggers on "is this verified", "can I trust this source", "is this
  canonical", "should I cite this", "ingest this into KMS" when the source is
  Light_*, or any operation that risks promoting untrusted material into KMS as
  fact. Refuses to cite from UNTRUSTED paths without "[unverified]" prefix and
  refuses to ingest into KMS without explicit user override. Codifies the rule
  stored in KMS memory 54f04f28-259e-4c8c-9f6e-64cefc8fff52. Do NOT use as a
  generic file-trust skill — this is L16/Lumen-corpus-specific and applies
  Rich's verify-before-trust standard for that domain.
version: 1.0
author: richard_yaker
---

# KMS Trust Boundaries — Corpus Trust Enforcement

Some directories on Rich's machine contain canonical, verified material. Others contain working drafts, experiments, AI-generated speculation, or untrusted external dumps. Treating them interchangeably has caused incorrect facts to leak into KMS in the past. This skill encodes the boundary.

The canonical write-up of this rule is stored in KMS as memory `54f04f28-259e-4c8c-9f6e-64cefc8fff52`. This skill is the agent-facing enforcement protocol.

## Trust Levels

| Path | Trust | Meaning |
|---|---|---|
| `/Users/ryaker/Dev/L16_Lumen_ReverseEngineering/` | **TRUSTED** | Codex-curated canonical L16/Lumen/libcp source. Cite freely. Ingest into KMS as `fact` / `procedure`. |
| `~/Documents/Light_Work/` (and `Light_*` siblings) | **UNTRUSTED** | Working drafts, AI-generated material, scratch notes, unverified external content. Do NOT cite as fact. Do NOT ingest into KMS without explicit user override. |
| Other Rich-authored notes in `~/Documents/Notes/`, code in `~/Dev/<other-projects>/` | Project-specific | Use project's own conventions; this skill does not override |

The path-name pattern matters: `Light_*` directories have **opposite** trust levels from each other and from `L16_Lumen_ReverseEngineering`. A file at `~/Documents/Light_Work/phoenix-config.md` and one at `~/Dev/L16_Lumen_ReverseEngineering/phoenix-config.md` may say opposite things — the L16 path wins.

## Trigger Conditions

Fire on:
- ANY file operation (Read, Grep, ingest, cite, summarize) where the path matches `Light_*`
- ANY claim about Lumen, libcp, L16, or related reverse-engineering topics where source provenance matters
- User asks "is this verified" / "can I trust this source" / "is this canonical"
- About to call `unified_store` with content sourced from an UNTRUSTED path
- About to cite a fact in an answer where the source is UNTRUSTED

Do NOT fire on:
- Generic file operations on unrelated directories
- Citation of L16 facts where the source is the TRUSTED `L16_Lumen_ReverseEngineering` repo
- Quoting Rich-authored notes in `~/Documents/Notes/` (those are Rich's working space — neither blanket-trusted nor blanket-untrusted, treated case-by-case)

## Behavioral Rules

### Rule 1: Reading Is Allowed; Citing Is Constrained

You MAY read files under UNTRUSTED paths (`Light_*`) — they often contain context Rich wants you to consider. What's constrained is **citing them as fact**.

When you cite content from an UNTRUSTED path:
- Prefix with `[unverified]` in the answer
- Name the source path explicitly so Rich can verify
- If a TRUSTED counterpart exists in `L16_Lumen_ReverseEngineering`, prefer it

Example:
```
Per ~/Documents/Light_Work/phoenix-camera-spec.md [unverified]: Phoenix uses 6 cameras.

⚠ This contradicts the canonical entry in
  ~/Dev/L16_Lumen_ReverseEngineering/cameras/phoenix.md, which says camera count
  is configuration-dependent (config 0 = 4 cameras, config 2 = 6 cameras).

Recommend deferring to the L16 repo unless you have new info.
```

### Rule 2: Do NOT Ingest UNTRUSTED Content Into KMS Without Explicit Override

Before calling `unified_store` with content from a `Light_*` path:
1. STOP. Tell Rich: "This content is from an UNTRUSTED path (`<path>`). Ingesting into KMS would promote it to fact-status."
2. Ask: "Do you want me to (a) ingest with `metadata.trust=unverified`, (b) verify against L16 repo first, or (c) skip the ingest?"
3. Wait for explicit approval.

Default to (c) skip. The cost of a wrong fact in KMS leaking into every future session via context injection is high; the cost of skipping a draft is zero.

If approval is given:
- Always include `metadata.trust: "unverified"` and `metadata.source_path: "<full path>"`
- Always include `metadata.subject` so future supersede calls can fix it cleanly
- Strongly consider `contentType: pattern` or a flag like `'UNVERIFIED'` instead of `fact`/`insight`

### Rule 3: For ANY Lumen/libcp/L16 Claim — Prefer the TRUSTED Source

When generating an answer that involves Lumen, libcp, or L16:
1. Check if `L16_Lumen_ReverseEngineering` has the relevant info first
2. If user-cited material conflicts with L16 repo, surface the conflict — don't silently pick one
3. KMS entries with `metadata.subject = L16.*` should be checked against the L16 repo if the entry is older than 30 days; the repo is the moving canonical, KMS entries are point-in-time captures

### Rule 4: Verify-Before-Trust Extends to Path-Name Heuristics

Same path-name pattern, opposite trust levels:
- `Light_Work` ≠ `L16_Lumen_ReverseEngineering` despite the visual similarity
- A future directory named `Light_Lumen_v2/` would be UNTRUSTED until Rich explicitly promotes it

When in doubt about a new directory's trust level, ASK before treating it as canonical.

## Operational Checklist (Fast Reference)

Before any write that could touch the L16/Lumen knowledge boundary:

```
[ ] Source path identified
[ ] Trust level determined (TRUSTED / UNTRUSTED / project-specific)
[ ] If UNTRUSTED: did Rich explicitly approve KMS ingest?
[ ] If citing: is "[unverified]" prefix present for UNTRUSTED sources?
[ ] If conflict with L16 repo: surfaced explicitly to Rich?
[ ] Subject facet set for future supersede-ability?
```

## Cross-Reference

- Canonical write-up of this rule: KMS memory `54f04f28-259e-4c8c-9f6e-64cefc8fff52`
- Related: `kms-search-first` (always check KMS before generating Lumen claims)
- Related: `kms-meeting-synthesis` (transcripts of L16 review meetings ARE trusted, ingest with subject `L16.*`)
- Corrective when wrong fact leaked through: `kms_supersede` with reason citing this skill's Rule 2 violation
