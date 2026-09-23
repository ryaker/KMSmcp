# KMS internals: corrections, dedup gate, Mem0

Moved out of `CLAUDE.md` on 2026-09-23. `CLAUDE.md` keeps the rules. This file keeps the
mechanism, the history, and the measurements behind them.

## Flagged entries and Mem0 shards

`unified_search` (and the `kms-context-fetch.py` UserPromptSubmit hook that calls it)
default-excludes flagged entries across all three backends, including Mem0's fan-out shards.
Pass `options.includeFlagged: true` to see them (audit/reaper paths only).

That became true on 2026-08-01 (PR #91) and was **false** before it. Mem0's extractor splits
every `unified_store` write into several "User described…" rows. Each is a separate
searchable entry, linked back only by `metadata.kms_id`. Mem0 has no flag concept, so
`kms_supersede` / `kms_delete` flagged the graph and MongoDB copies but left every shard
live, and shards rank *well* because the extractor restates the source in query-like
language. Measured right after superseding 2 entries and deleting 5: three flagged parents
still had 11 shards in the top 15 across six queries. `searchMem0` now drops shards whose
parent is flagged.

Two limits remain. Mem0-only entries can't be corrected, because they have no parent to
flag. And every write still fans out into several retrievable rows.

## Mem0 narrative timestamps

`Mem0Storage.store()` passes the knowledge's `timestamp` as the add's top-level `timestamp`
(epoch seconds). Without it, mem0's server-side extractor stamps the **ingestion** date
into shard text. In the 2026-09-22 DolphinBench probe, a 2023-03-06 event was rewritten to
"September 22, 2026". The ISO timestamp also stays in `metadata.timestamp`; the two are
separate fields on separate layers. Tests: `src/__tests__/Mem0Storage.store.timestamp.test.ts`,
plus a live smoke test (`Mem0Storage.store.timestamp.live.test.ts`, skipped unless
`KMS_MEM0_LIVE_SMOKE=1`).

- **Tool path: fixed.** `unified_store` accepts a `timestamp` arg (ISO string or epoch
  seconds), PR #122, which flows into `knowledge.timestamp`. An earlier note saying the schema
  had no `timestamp` property predates that PR.
- **Still open:** `Mem0Storage.update()` sends only `{ text }` to `client.update()`, so a
  `kms_update` re-runs extraction without the event timestamp. The SDK's `update()` accepts
  `timestamp`.

## How `kms_supersede` works (issue #62 fix)

The router always writes `graph + mem0`. It adds `mongodb` only for `procedure`,
`source=technical`, or structured-content matches, so an `insight` may not exist in MongoDB
at all. Supersede therefore:
1. Probes each backend with `findById(old_id)`.
2. Builds `requiredBackends` from the probes (e.g. `[sparrowdb]`, or `[sparrowdb, mongodb]`).
3. Flags only those, skipping absent backends with a debug log.
4. Succeeds only if every required flag succeeds. Otherwise it hard-deletes the new entry and
   un-flags the partial successes.

Before the fix, supersede always required MongoDB.flag, which failed silently for graph-only
entries and left 4 of 12 historical chains with orphan `superseded_by` ids (DG-INV-2 audit).
`supersede: old_id <id> not found in any backend` means the id is wrong, not a routing oddity.

## Dedup gate: response shape and details

```json
{
  "status": "dedup_required",
  "candidates": [{ "id": "abc-123", "similarity": 0.91, "content_preview": "...",
    "contentType": "fact", "subject": "Phoenix.camera_count", "created": "2026-04-13T...",
    "flag": null, "llm_relation": "duplicate" }],
  "message": "Likely duplicate found (cos=0.91 >= 0.88). Retry with action.",
  "retry_with": ["action=supersede&old_id=abc-123&reason=<...>", "action=update&old_id=abc-123&reason=<...>",
    "action=complement&related_to=abc-123", "action=force-new&reason=<justification>"],
  "band": "refuse", "thresholds": { "refuse": 0.88, "confirm": 0.78 }
}
```

Action results:
- `supersede` → `{ status: 'superseded', success, id, old_id, backends, reason, error? }`
- `update` → `{ status: 'updated', success, id, backends, reason }`
- `complement` stores a new entry with `metadata.related_to` merged
- `force-new` stores one with `metadata.force_new_reason`
- A missing required field → `{ status: 'invalid_action', success: false, error }`, and nothing is stored.

Thresholds were calibrated on the real corpus by DG-INV-2. `procedure` refutation rewrites
cluster lower (0.85); `pattern` duplicates are extremely tight (0.92).

**Contradictions (DG-T2-B, issue #50):** when any candidate is `contradicts`, the response
carries `contradicts_detected: true` and `contradicting_ids`. The `message` says CONTRADICTION,
and `retry_with` narrows to `supersede` and `force-new` (the reason must argue the claims
aren't actually opposed, e.g. different time periods).

**Episodic mode (DG-EPISODIC):** `writeMode: "episodic"` runs only the Tier 0 exact fingerprint
check, because the interactive gate refused 25% of chronological life history in the
2026-09-22 DolphinBench probe. Exact duplicates still refuse, and entries are tagged
`metadata.write_mode: "episodic"`. `options.skip_dedup` (admin) skips Tier 0 too. Two
deliberate exclusions:
- Episodic writes never reach the Jev write-dedup shadow (Experiment 2), because that
  shadow lives inside the Tier 1 block.
- `action=supersede` retries don't forward `writeMode`, so a correction is stored standard.

## Tier 2 judge: model choice and budget

Model: `DEFAULT_OLLAMA_MODEL` in `src/inference/OllamaInference.ts`, currently `gemma4:12b-mlx`
on rym1 (M1, 16 GB, shared with CI). `OLLAMA_MODEL` overrides it. It was chosen by measuring the
real judge on 18 labeled cases:

| Model | Score | `contradicts` caught |
|---|---|---|
| gemma4:12b-mlx | 15/18 | 3/3 |
| qwen3.5:9b-mlx | 13/18 | 3/3 |
| qwen3:8b | 9/18 | **0/3** |

The router and the judge share one model because two ~8 GB models can't co-reside on rym1.
Router and entity calls pass a JSON Schema in Ollama's `format` field; Gemma otherwise
intermittently fences JSON in markdown (PR #125).

Budget: 8 s per candidate. A cold load of gemma4:12b-mlx measured 45 s, so the first call
after eviction degrades to `llm_relation: null`. rym1 sets `OLLAMA_KEEP_ALIVE=30m`. The
response is forced to a single word (~12 tokens) with `think: false`. Results are LRU-cached
(1000 entries per process), and refuse-band candidates skip the LLM entirely.
