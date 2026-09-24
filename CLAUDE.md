# KMS Unified MCP — Claude Instructions

KMS stores and retrieves knowledge across Mem0 (episodic/preferences), SparrowDB (embedded
graph, concept relationships), and MongoDB (structured/technical). `unified_store` routes
each write; `unified_search` fans out across all three.

**Read on demand:**
- `docs/sparrowdb-notes.md` — **before writing any SparrowDB query**, or anything about SparrowDB, into this file.
- `docs/kms-internals.md` — supersede internals, Mem0 shard/timestamp behavior, the dedup
  response shape, and how the judge model was chosen.

## Search first, store smart

- Search before storing, and before giving technical advice from memory.
- Store novel, verified facts: decisions with their reasons, fixes, preferences, patterns. One fact per entry.
- Set `metadata.subject` as a dotted facet (`Project.fact_name`, `Person.preferences.facet`).
  Reuse it for every write about that fact: it scopes dedup and keeps supersede chains queryable
  (`unified_search({ filters: { subject: "Phoenix.camera_count" } })`).
- Pass `timestamp` (ISO or epoch seconds) when content is about a past date, so Mem0 doesn't
  stamp the ingestion date into it.

## Correcting wrong entries — never an additive store

If a new fact contradicts or replaces a stored one, **do not call `unified_store` again**.
Both entries would leak into every future session's injected context.

| You want to... | Use |
|---|---|
| Correct a wrong fact (common case) | `kms_supersede(old_id, new_content, reason)` — atomic; old flagged SUPERSEDED, chain kept |
| Minor edit to the same fact (typo, confidence, metadata) | `kms_update(id, content, reason)` |
| Delete noise with no replacement | `kms_delete(id, reason)` — soft, reversible 90 days |
| Mark partially wrong, no replacement | `kms_flag(id, 'RETRACTED' \| 'UNVERIFIED', note)` |
| Hard-delete old flagged entries | `kms_reap({ olderThanDays: 90, dryRun: true })` — admin |

Flagged entries are hidden from search and context injection, including Mem0 shards.
Prefer supersede over delete: the mistake is data.

## Review queue and secret scrubbing

- **Review queue.** `unified_store` with `review: "candidate"` writes the entry flagged
  `CANDIDATE`: stored everywhere, hidden from search and injection until `kms_review`
  (`list` / `approve` / `reject`) acts on it. The importers (Granola, Slack, markdown
  claims) default to it; `--no-review` writes live. Deliberate stores don't use it.
  `kms_review` refuses anything that isn't a `CANDIDATE`.
- **Secrets are masked on every write** (`unified_store`, `kms_update`, `kms_supersede`)
  before any backend, since Mem0 is hosted. Values become `[REDACTED:<type>]`; only
  `metadata.redactions` (`{type, count}`) is recorded. `src/security/secretScrub.ts`.

## Dedup gate

Every `unified_store` is checked against near-duplicates with the same `userId` +
`contentType` (+ `metadata.subject` when set). Cosine on local `nomic-embed-text` embeddings:

| Similarity | Band | Result |
|---|---|---|
| `>= 0.88` (`procedure` 0.85, `pattern` 0.92) | refuse | `dedup_required` |
| `0.78 – 0.88` | confirm | `dedup_required` + Tier 2 `llm_relation` |
| `< 0.78` | — | stored |

On `dedup_required`, retry the same call with exactly one `action`. Never repeat the original write:

| `action` | Needs | Effect |
|---|---|---|
| `supersede` | `old_id`, `reason` | atomic replace |
| `update` | `old_id`, `reason` | in-place edit |
| `complement` | `related_to` | new entry linked to the old one |
| `force-new` | `reason` | new entry, gate bypassed |

**Tier 2 `llm_relation`** — local Ollama judge on rym1 (`DEFAULT_OLLAMA_MODEL`, currently `gemma4:12b-mlx`):

| Relation | Do |
|---|---|
| `duplicate` | nothing to add — skip the write |
| `supersedes` | `action=supersede` |
| `supersedes-reverse` | existing entry is newer; don't write (maybe `kms_update` it) |
| `complement` | `action=complement` |
| `contradicts` | **STOP.** Surface it to the human; one side must be retracted (`kms_supersede` or `kms_flag RETRACTED`). `force-new` only with a reason arguing they are not actually opposed. |
| `unrelated` | `action=force-new` — the embedder misfired |

If Ollama is unreachable, `llm_relation` is `null` and the gate runs on cosine alone. The
embedder is also Ollama, so one outage disables both tiers. For bulk/episodic ingestion
(transcripts, benchmark history), pass `writeMode: "episodic"`: only exact duplicates are refused.

## Operating the servers

- The live servers (`com.ryaker.kms-mcp-eng`, `com.ryaker.kms-mcp`) run
  `node --watch dist/index.js` from **this checkout**. `npm run build` here deploys to production.
- Doppler (`ry-local` `dev_eng` / `dev_personal`) injects env only at process start. A Doppler
  change needs `launchctl kickstart -k gui/$(id -u)/<agent>`.
- After a deploy, confirm with a real `unified_store`: the router should report
  `llm(...)`, not `regex(confidence=0.50)`.
- Never run Ollama inference on this Mac mini (16 GB, CI host). Local models run on rym1
  (`OLLAMA_BASE_URL`, Tailscale `100.127.128.76:11434`).
