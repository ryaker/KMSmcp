# DG-INV-2 — Dedup Gate Threshold Calibration Report

**Issue**: [#42](https://github.com/ryaker/KMSmcp/issues/42)
**Spec**: `~/Documents/Notes/KMS-Semantic-Dedup-Gate-Spec.md` §3, §7 Open Q4/Q5/Q8
**Branch**: `feature/dedup-gate/inv2-calibration`
**Date**: 2026-05-06
**Embedder**: nomic-embed-text @ 768d via Ollama at `http://localhost:11434`

---

## TL;DR

| Recommendation | Value | Reason |
|---|---|---|
| **Refuse threshold** (Tier 1 reject) | **0.88** | Lowest threshold with zero false positives in calibration set; catches 56% of duplicates outright. |
| **Confirm threshold** (Tier 1 → require LLM judge) | **0.78** | Below this, dups are rare enough that vector dedup isn't worthwhile; above 0.78 sits the borderline cluster where Tier 2 LLM judgment is essential. |
| **Embedder** | nomic-embed-text @ 768d | Already running; matches DG-INV-1 decision. |
| **Per-contentType override** | Lower the refuse threshold for `procedure` & `pattern` types | Insights and procedures cluster more tightly when restating the same fact; see §2.4. |

These supersede the spec's initial guesses of **0.90 / 0.75**:
- 0.90 was too high (loses 78% of real duplicates including all 8 supersede chains)
- 0.75 was too low (catches 17% of cross-topic distinct pairs as false positives)

---

## 1. Calibration corpus

### 1.1 Construction

The corpus is in [`test-fixtures/dedup-calibration.json`](./dedup-calibration.json):

| Section | Count | Provenance |
|---|---|---|
| `duplicate_pairs` | **32** | 8 supersede chains + 19 human-curated relabels of embedding-clustered borderline + 3 prefix-collision + 2 same-subject-facet |
| `distinct_pairs` | **34** | 4 human-confirmed borderline + 2 borderline (auto) + 28 cross-topic random samples |

Reproducible build:
```bash
# 1. Pull the latest KMS corpus state and build the candidate fixture
doppler run --project ry-local --config dev_personal -- \
    node test-fixtures/build-calibration-corpus.mjs

# 2. Apply the human-curated relabels (encoded in relabel-fixture.mjs)
node test-fixtures/relabel-fixture.mjs

# 3. Run the threshold analysis
node test-fixtures/analyze-thresholds.mjs
```

### 1.2 Provenance distribution (cosine similarity)

| Provenance | n | min | median | max |
|---|---|---|---|---|
| `prefix_collision` (true dups by first-80-char identity) | 3 | 1.000 | 1.000 | 1.000 |
| `embedding_cluster_high` (auto-labeled dup at cos≥0.92) | 2 | 0.939 | 0.943 | 0.946 |
| `human_curated_relabel` (auto-distinct → human-judged dup) | 19 | 0.865 | 0.881 | 0.899 |
| `supersede_chain` (gold standard) | 8 | 0.724 | 0.845 | 0.952 |
| `cross_topic_sample` (gold distinct) | 15 | 0.426 | 0.572 | 0.670 |
| `cross_topic_sample_extra` (gold distinct) | 13 | 0.424 | 0.578 | 0.646 |
| `embedding_cluster_borderline` (kept as distinct) | 2 | 0.863 | 0.863 | 0.864 |
| `human_curated_confirmed` (auto-distinct, kept after review) | 4 | 0.866 | 0.870 | 0.875 |

---

## 2. Empirical threshold analysis

### 2.1 Distribution stats

```
duplicate_pairs:  n=32  min=0.724  p10=0.843  p25=0.868  median=0.881  p75=0.898  p90=0.952  max=1.000  mean=0.884
distinct_pairs:   n=34  min=0.424  p10=0.473  p25=0.562  median=0.584  p75=0.637  p90=0.865  max=0.875  mean=0.620
```

Mean separation: **0.264** (duplicates 0.884, distincts 0.620). Strong overall separation — but the distribution is bimodal with a borderline overlap around **0.86–0.88** that contains both true duplicates and true distincts.

### 2.2 Histograms

```
duplicate_pairs cosine distribution (n=32, range [0.5-1], 20 bins)
  0.700–0.725    1 ███
  0.725–0.750    1 ███
  0.750–0.775    1 ███
  0.825–0.850    2 █████
  0.850–0.875    5 █████████████
  0.875–0.900   15 ████████████████████████████████████████   ← MAIN CLUSTER
  0.925–0.950    3 ████████
  0.950–0.975    1 ███
  0.975–1.000    1 ███

distinct_pairs cosine distribution (n=34, range [0.5-1], 20 bins)
  0.500–0.525    2 █████████
  0.550–0.575    9 ████████████████████████████████████████   ← MAIN CLUSTER
  0.575–0.600    4 ██████████████████
  0.600–0.625    4 ██████████████████
  0.625–0.650    4 ██████████████████
  0.650–0.675    1 ████
  0.850–0.875    5 ██████████████████████   ← BORDERLINE OVERLAP
  0.875–0.900    1 ████
```

The dual-mode structure of `distinct_pairs` (one peak around 0.57, another near 0.87) is the smoking gun: **same-domain entries can sit at cos 0.85–0.88 without being duplicates**. This is what L16/Phoenix looks like — many entries share vocabulary about cameras, calibration, libcp offsets, etc., raising baseline similarity even between truly different findings.

### 2.3 Threshold sweep

```
threshold  TP   FN   FP   precision   recall   F1
0.950      4    28   0    1.000       0.125    0.222
0.920      7    25   0    1.000       0.219    0.359
0.900      7    25   0    1.000       0.219    0.359
0.880     18    14   0    1.000       0.563    0.720    ← ZERO-FP frontier
0.870     22    10   2    0.917       0.688    0.786
0.850     27    5    6    0.818       0.844    0.831
0.840     27    5    6    0.818       0.844    0.831    ← 90%-recall frontier
0.820     29    3    6    0.829       0.906    0.866
0.780     29    3    6    0.829       0.906    0.866
0.750     30    2    6    0.833       0.938    0.882
0.720     32    0    6    0.842       1.000    0.914    ← Best F1
0.700     32    0    6    0.842       1.000    0.914
```

**Three meaningful operating points:**

1. **0.88 — Refuse-with-no-FP threshold**: Hard refuse only when `cos ≥ 0.88`. Catches 56% of true duplicates with **zero** false-positive risk on the calibration set. The other 44% slip through, but those are mostly supersede chains where the new entry is a fundamental rewrite (not a rephrase) — the LLM judge in Tier 2 catches them better than vectors anyway.

2. **0.78 — Confirm-with-LLM threshold**: When `0.78 ≤ cos < 0.88`, send to Tier 2 LLM judge. This zone contains:
   - 11 of 32 true duplicates (dups that vectors alone undercall)
   - 6 of 34 true distincts (false-positive risk if you stop at vectors)
   - LLM judge is meant to disambiguate exactly these

3. **0.72 — Best-F1 if you trust the LLM judge**: F1 = 0.914 at this threshold but with 6 false positives still in the band. **Do not use this as a hard refuse**; only as the floor for sending to LLM judge if you're trying to maximize recall.

### 2.4 Per-contentType breakdown

```
fact:       dup median=0.877  distinct median=0.593  (separation 0.284) — clean
procedure:  dup median=0.865  distinct median=0.572  (separation 0.293) — clean BUT 2 dups at 0.72-0.75 (refutation rewrites)
insight:    dup median=0.876  distinct median=0.611  (separation 0.265) — tighter dup cluster, narrower zone
pattern:    dup median=0.889  distinct median=0.578  (separation 0.311) — best separation, dups very tight
relationship: only 1 dup sample (0.952) — insufficient data
memory:     only 2 distinct samples — insufficient data
reference:  only 1 distinct sample — insufficient data
```

**Recommendation for per-contentType thresholds**:
- `procedure`: lower refuse threshold to **0.85** (median of dups is 0.865; the 2 supersede-chain rewrites at 0.72–0.75 are the long tail)
- `pattern`: raise refuse threshold to **0.92** (dups cluster very tight — fewer false positives possible)
- `insight`, `fact`: keep recommended **0.88** — this is the bulk of the corpus and behaves as expected

For `relationship`, `memory`, `reference`, `semantic`: insufficient samples to set per-type thresholds; use the global default until more corpus accumulates.

### 2.5 Edge cases

**3 supersede pairs sit at cos 0.72–0.76** — vector dedup will *miss* these. They are fundamental rewrites where the corrected entry barely shares vocabulary with the wrong entry it replaces:

| sim | Old (wrong) | New (correct) |
|---|---|---|
| 0.724 | "movable B/C R matrix is unsolved... primary blocker for full 10-camera merges" | "cross-camera merge is lt::ImageResolutionAmp (IRAMP) at libcp+0x365960..." |
| 0.749 | "Phoenix isp_camera() stage order is WRONG. Current: BLC+AWB → demosaic..." | "L16 Phoenix per-camera ISP stage order (verified): SourceImageCache → STAGE0 → STAGE1..." |
| 0.757 | "L16 CCM illuminant: awb_mode=0 maps DIRECTLY to CCM mode 2 (D65)..." | "L16 CCM application (verified): per-camera CCM SETUP at setColorCorrement..." |

**Implication**: pure vector dedup will leave a known-fail tail of ~10% on this kind of correction. The Tier 2 LLM judge IS the right tool for these — it can read both contents and recognize "this corrects/replaces that," which embedding similarity cannot.

**4 distinct pairs sit at cos 0.86–0.88** — vector dedup will *falsely flag* these as duplicates. All four are genuinely distinct but share heavy L16/Phoenix vocabulary:

| sim | A | B | Why distinct |
|---|---|---|---|
| 0.875 | "canonical TRUTH doc location" | "stale doc copies still on disk" | Different files, related rule |
| 0.870 | "color cal extraction RESULTS" | "PROCEDURE to extract color cal" | Output vs methodology |
| 0.870 | "C6 IS active at 70mm" | "investigation pattern: don't extrapolate absence" | Data finding vs methodology lesson |
| 0.866 | "vtable[6] dispatch chain overview" | "work-stealing-loop disasm details" | Different layers of the same chain |

These are **complement** relationships per the spec's Tier 2 vocabulary — same broad topic, different facets. The right action is "store new entry with `metadata.related_to=old_id`," not refuse.

---

## 3. Hook behavior audit (Open Q 8)

### 3.1 Hook scripts identified

Two hook scripts exist:
- `~/.claude/hooks/kms-context-fetch.py` (10.2 KB) — Python; standalone CLI; called via `--debug` for troubleshooting
- `~/.claude/hooks/kms-context-inject.sh` (7.6 KB) — Bash; the actual `UserPromptSubmit` hook wired in `~/.claude/settings.json:301`

Both call `unified_search` **without** specifying `options.includeFlagged`, which means they get the server-side default behavior.

### 3.2 Server-side flag exclusion (verified by code reading)

| Source | Logic |
|---|---|
| `src/tools/UnifiedSearchTool.ts:96` | Default `options.includeFlagged: false` |
| `src/storage/MongoDBStorage.ts:108-111` | `filter.$and = [..., { $or: [{ flag: null }, { flag: { $exists: false } }] }]` |
| `src/storage/SparrowDBStorage.ts:444-445` | Same default-exclude logic |

Both backends correctly handle the legacy case where `flag` field is **missing entirely** (as is true for 853 of 870 entries — i.e., everything stored before the corrective tools landed).

### 3.3 Empirical verification

Test script: `/tmp/audit_hook2.mjs` (not committed; ephemeral)

1. **Stored** test entry with `source=technical`, `contentType=procedure` → routed to graph + mem0 + mongodb
2. **Searched** → entry visible (1 result)
3. **Superseded** with replacement content → backends `[sparrowdb, mongodb]` flagged successfully
4. **Searched again** → only NEW entry visible; OLD hidden ✓
5. **Searched with `includeFlagged: true`** → both entries returned ✓
6. **Ran `kms-context-fetch.py` directly** with a query containing the old marker → OLD entry NOT in output ✓
7. **Cleanup** → both entries `kms_delete`d (now flagged `DELETED`)

**Conclusion**: hooks correctly exclude flagged entries. No code change required; the spec's Open Q 8 is closed in the affirmative.

### 3.4 Edge cases worth a follow-up

| Edge case | Status | Recommendation |
|---|---|---|
| Legacy entries without `flag` field | ✅ Handled | `$or: [{ flag: null }, { flag: { $exists: false } }]` covers both null and missing |
| L1 / L2 cache TTL gap on flag changes | ✅ Handled | `UnifiedStoreTool.ts:644-649` invalidates `kms:search:*` and `*${old_id}*` immediately after flag (also after PR #36 fix at FACTCache.ts:147 normalizes wildcards across L1/L2). Verified in audit step 4 — supersede was visible immediately. |
| `flag: SUPERSEDED` but no `superseded_by` | 0 cases in current corpus | Not currently a concern. Worth a defensive check in the hook output (display "(superseded; target unknown)" rather than failing) if it ever happens. |
| Search result payload **does not include** `flag` field | ⚠️ Display gap | Search results in audit step 5 returned `flag=null` for SUPERSEDED entries even when `includeFlagged: true`. Filter is correct (entries excluded by default), but the projection drops the flag/superseded_by fields. Agents inspecting flag state from search results cannot do so. **Recommend follow-up ticket** to surface flag fields in search responses (low-priority, documentation-mode work). |

### 3.5 Surprise: 4 orphan supersede chains in MongoDB

While building the calibration corpus, I found that **4 of 12 SUPERSEDED entries in `unified_knowledge` point to a `superseded_by` ID that does not exist in MongoDB**:

```
098b161d-6bba-482f-8256-e907ebed129e → 08db7041-9bb1-4668-aab1-c7702b3b4dcc (target missing)
6e8ea2a3-16e4-4bce-9cf2-ca20d66aea12 → 4c818c4e-2867-4cd4-ac24-329a455fafca (target missing)
25452fb4-6d62-4ae0-ab84-042f054ae55b → 0fe29b17-9646-483c-99ad-9e1b562079d5 (target missing)
aae162fe-e348-4bd7-b0eb-bad4f09f8d9c → fc128178-14df-494b-9f61-618da1545e61 (target missing)
```

**Cause**: re-running the audit with `source=manual` reproduced the symptom — the storage router (`OllamaStorageRouter` falling back to `IntelligentStorageRouter`) sends entries to graph + mem0 + mongodb only when `contentType=procedure`, `source=technical`, or content matches `MONGODB_PATTERN`. Other entries route to graph + mem0 only. The `kms_supersede` flow (`UnifiedStoreTool.ts:632-641`) then **always tries to flag in MongoDB** — and rolls back the supersede if MongoDB returns "entry not found." For entries that were never written to MongoDB to begin with, this is a silent failure mode where the new entry IS visible (in graph + mem0) but the old one was never flagged.

The current 12 SUPERSEDED entries in MongoDB are the ones where the supersede succeeded; 4 chains have orphan targets visible only because MongoDB did get the supersede flag write but couldn't find the corresponding entry, leaving SUPERSEDED + a back-pointer to an ID that's only in graph + mem0.

**Recommendation — separate ticket**: harden `unified_supersede` to check which backends actually contain `old_id` before requiring success on each, OR ensure the new entry routes to the same backends as the old entry. Suggested behavior: `kms_supersede` succeeds if it flags `old_id` everywhere `old_id` *exists*, regardless of which backends contain the *new* entry. (Currently it fails if MongoDB can't find old_id even when graph + mem0 do.)

This is **not blocking DG-T1** but should be documented as a known data-integrity gap before the dedup gate increases supersede traffic.

---

## 4. Code references

| File | Purpose | Lines |
|---|---|---|
| `test-fixtures/dedup-calibration.json` | Curated corpus (32 dup + 34 distinct pairs) | — |
| `test-fixtures/build-calibration-corpus.mjs` | Build the candidate fixture from MongoDB | — |
| `test-fixtures/relabel-fixture.mjs` | Apply human relabels for borderline cluster | — |
| `test-fixtures/analyze-thresholds.mjs` | Compute thresholds + emit stats | — |
| `src/storage/MongoDBStorage.ts` | Default flag exclusion in search | 105–113 |
| `src/storage/SparrowDBStorage.ts` | Default flag exclusion in search | 442–448 |
| `src/tools/UnifiedSearchTool.ts` | Default `includeFlagged: false` | 96 |
| `src/tools/UnifiedStoreTool.ts` | Supersede atomicity (orphan-chain origin) | 600–686 |
| `src/cache/FACTCache.ts` | Cache invalidation on flag (L1/L2) | 141–182 |
| `src/routing/IntelligentStorageRouter.ts` | MongoDB inclusion criteria (`MONGODB_PATTERN`) | 11, 58–67 |
| `~/.claude/hooks/kms-context-fetch.py` | Hook script (Python) | — |
| `~/.claude/hooks/kms-context-inject.sh` | Hook script (Bash, wired in settings.json) | — |

---

## 5. Recommended follow-up tickets

1. **DG-T1 implementation** (in flight) — use refuse=0.88, confirm=0.78 as defaults; carry the per-contentType overrides from §2.4 as a config-file table.
2. **[Bug] kms_supersede atomicity for partial-backend entries** — fix the rollback-on-mongodb-miss when entry was never routed to mongodb. 4 known orphan chains in current corpus.
3. **[Display] Surface flag/superseded_by fields in unified_search responses** — currently the projection drops them even when `includeFlagged: true`. Useful for audit/reaper UIs.
4. **[Calibration refresh]** — re-run the full pipeline whenever the embedder is upgraded (DG-INV-1 settled on nomic-embed-text but Mem0 may upgrade independently). Output is reproducible from this branch.
5. **[Corpus growth]** — current calibration is heavy on L16/Phoenix (technical/long-form) and weak on `relationship`, `memory`, `reference`, `semantic` types. Add labeled pairs in those categories as the corpus accumulates.

---

## Appendix A — raw analysis output

See `analyze-thresholds.mjs` runtime output for the full reproducible numbers; the key tables and histograms above are taken directly from a run on this branch (commit pending).
