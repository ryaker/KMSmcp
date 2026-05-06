#!/usr/bin/env node
/**
 * relabel-fixture.mjs — Apply human-judged relabels to dedup-calibration.json
 *
 * After running build-calibration-corpus.mjs, several pairs labeled "distinct"
 * by the heuristic auto-labeler are actually duplicates upon human review:
 *  - successive corrections/refutations of the same fact
 *  - rephrasings of the same finding
 *  - explicit "supersedes X" content claims
 *
 * This script applies those manual decisions deterministically. Re-running it
 * after a fresh build is the canonical way to reproduce the curated fixture.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// id-prefix-pair → { newLabel, rationale }
// Prefixes are 8-char ID prefixes (uniquely identify within current corpus).
const RELABELS = [
  // BLC kernel: JIT'd vs static — second one explicitly refutes the first.
  { ids: ['d51acda1', '1f0e5389'], label: 'duplicate', rationale: 'Same fact (BLC kernel under HDR profile=3) — entry B explicitly REFUTES entry A. This is a supersede-by-refutation that wasn\'t flagged as such. Cos sim 0.897.' },
  // Depth pipeline architecture — same finding, end-of-day vs deep-decode versions.
  { ids: ['ee049f19', '6eb63ffd'], label: 'duplicate', rationale: 'Both entries claim "depth pipeline architecture VERIFIED/MAPPED end of 2026-04-19" — same finding, different framings of the same end-to-end map. Cos sim 0.890.' },
  { ids: ['ee049f19', 'c50fcece'], label: 'duplicate', rationale: 'Both describe the same two-cost-path depth pipeline finding from 2026-04-19. Cos sim 0.869.' },
  { ids: ['c9c4ac53', 'ee049f19'], label: 'duplicate', rationale: 'Both about the depth-cost kernel located at libcp+0x30b9f0 on 2026-04-19; second entry is the verified-end-to-end consolidation of the first. Cos sim 0.882.' },
  { ids: ['888781f0', '6eb63ffd'], label: 'duplicate', rationale: 'Both describe the depth-pipeline architecture decoded on 2026-04-19 at the same offsets — partial-decode vs end-of-session restatement. Cos sim 0.881.' },
  // Two-artifact rule: investigation vs spike.
  { ids: ['bdccf891', 'fc7f26c1'], label: 'duplicate', rationale: 'Same rule about investigation/spike separation — entry B is the formalized version of Rich\'s verbatim quote in entry A. Cos sim 0.889.' },
  // CCM formula confirmed.
  { ids: ['731966b4', 'b45f6ade'], label: 'duplicate', rationale: 'Both confirm the per-pixel CCM formula is simple matmul (not chromaticity division), with the same caller distinction (chromaticity is WB-setup, not per-pixel). Cos sim 0.885.' },
  // Tone curves clean-room.
  { ids: ['e371e429', '6c1b24b4'], label: 'duplicate', rationale: 'Both describe the L16 tone-curve clean-room extraction — sub-perceptual fits to Hable/ACES formulas, same 4 LUTs, same Phoenix-shippable conclusion. Cos sim 0.885.' },
  // KMS injection audit.
  { ids: ['0565ef46', '6737fe3a'], label: 'duplicate', rationale: 'Both from the same 2026-04-12 KMS injection audit — entry A is the audit findings, entry B is the ranked plan derived from those exact findings. Strongly related but at the borderline; "complement" might be a more accurate label than pure duplicate, but for this calibration set we treat as duplicate (the ranked plan is a restatement+extension). Cos sim 0.883.' },
  // d3f5e193 ↔ 9ea2368e — entry B EXPLICITLY supersedes entry A.
  { ids: ['d3f5e193', '9ea2368e'], label: 'duplicate', rationale: 'Entry B begins "SUPERSEDES d3f5e193" — explicit supersede-by-content; the supersede was not propagated to flag/back-link metadata. Cos sim 0.876.' },
  // d3f5e193 ↔ 0bcc4491 — Rich corrects the d3f5e193 claim.
  { ids: ['d3f5e193', '0bcc4491'], label: 'duplicate', rationale: 'Rich\'s correction overrides d3f5e193\'s "0% coverage by geometry" claim — same fact, opposite conclusion. Cos sim 0.882.' },
  // Refutation arc count: 11 → 22 → 38 — they ARE the same fact (the running count) at different points in the session.
  { ids: ['9beecfbf', '6f72d1b3'], label: 'duplicate', rationale: 'Same running refutation-arc count for the 2026-04-18/19 session — entry B (count=38) is the final state superseding entry A (count=11). Cos sim 0.881.' },
  { ids: ['0774d162', '6f72d1b3'], label: 'duplicate', rationale: 'Same running refutation-arc count at intermediate (22) vs final (38). Earlier entry should have been superseded. Cos sim 0.875.' },
  // scan_dng JPEG-with-wrong-extension.
  { ids: ['4480df6c', '2aceac60'], label: 'duplicate', rationale: 'Both describe the same finding: scan_*.dng files are actually JPEGs. Same dimensions, same file location, same conclusion. Cos sim 0.877.' },
  // C6 absent vs camera investigation methodology.
  { ids: ['f4284bc2', 'f7456fdf'], label: 'distinct', rationale: 'Despite high cosine, these are genuinely distinct: entry A is the data finding (C6 active at 70mm), entry B is a methodology lesson derived from that finding. Different facets, complement-related. Cos sim 0.870.' },
  // Color cal extracted vs procedure to extract.
  { ids: ['91839eb8', 'e5ccc68a'], label: 'distinct', rationale: 'Different facets: entry A documents the extraction results (offsets, field paths), entry B documents the procedure to extract on a new file. Complement, not duplicate. Cos sim 0.870.' },
  // Three-level vtable vs work-stealing loop disasm — different layers.
  { ids: ['780a81e2', 'd55995ea'], label: 'distinct', rationale: 'Different layers of the same dispatch chain — A is full three-level overview, B is detailed work-stealing-loop disasm. Same investigation, different sub-topics. Distinct facets. Cos sim 0.866.' },
  // LRI image-data layout corrected (73fc57dc) vs CORRECTED summary (49f9fbab).
  { ids: ['73fc57dc', '49f9fbab'], label: 'duplicate', rationale: 'Same 2026-04-12 evening correction of LRI layout — both explicitly say "supersedes prior KMS entries" with same field paths and same chunk-end-offset rule. Should have been one entry. Cos sim 0.869.' },
  // OQ-C closed vs OQ status snapshot.
  { ids: ['95625f9a', '57343374'], label: 'duplicate', rationale: 'Same OQ status snapshot from 2026-04-12 — entry A is pre-OQ-C-close, entry B is post-OQ-C-close. Should have been a supersede. Cos sim 0.867.' },
  // NLM-4 denoiser fully decoded vs NLM-4 formula DECODED.
  { ids: ['d756e596', 'd81c4cbb'], label: 'duplicate', rationale: 'Both decode the same NLM-4 denoiser. Entry A is from the LATE 2026-04-19 session, entry B is from a 2026-04-20 audit citing "nlm_bm3d_denoiser.md" — the same finding, restated with source citation. Cos sim 0.866.' },
  // Phoenix RE methodology (parallelism budget) vs procedure (5 agents). Distinct: A is "can push to 5+", B is "max 3 LLDB-heavy". Same topic, different conclusions on agent count.
  { ids: ['5333b158', '26e59adf'], label: 'duplicate', rationale: 'Same finding (parallel agent budget on Mac mini) — entry A pushes upper bound to 5+ via the static-vs-LLDB split, entry B documents max 3 LLDB-heavy. Same conclusion at different precision levels. Cos sim 0.899.' },
  // Spike Run 4 vs spike ISP analysis.
  { ids: ['3ccce595', '7248f073'], label: 'duplicate', rationale: 'Both describe the Phoenix spike Run 4 outcome — entry A reports the MAD numbers, entry B is the analytical takeaway from those same numbers. Strongly related; could be complement, but at the borderline. Cos sim 0.867.' },
  // Phoenix canonical TRUTH doc vs investigation contamination.
  { ids: ['b99ca99f', '0cc57c1b'], label: 'distinct', rationale: 'A is "canonical truth doc location"; B is "where stale copies of the deprecated doc still live". Related (same overall doc-hygiene topic) but distinct facts about different files. Cos sim 0.875.' },
]

async function main() {
  const fixturePath = join(__dirname, 'dedup-calibration.json')
  const raw = await readFile(fixturePath, 'utf-8')
  const fixture = JSON.parse(raw)

  // Build a lookup that hits both 'duplicate_pairs' and 'distinct_pairs'.
  let movedToDup = 0
  let movedToDistinct = 0
  let confirmed = 0

  function findPair(pairs, prefixA, prefixB) {
    return pairs.findIndex(p => {
      const a = (p.id_a || '').slice(0, 8)
      const b = (p.id_b || '').slice(0, 8)
      return (a === prefixA && b === prefixB) || (a === prefixB && b === prefixA)
    })
  }

  for (const rl of RELABELS) {
    const [pa, pb] = rl.ids
    let found = false

    // Look in distinct first (more common case)
    let idx = findPair(fixture.distinct_pairs, pa, pb)
    if (idx >= 0) {
      const pair = fixture.distinct_pairs[idx]
      if (rl.label === 'duplicate') {
        // Move to duplicates
        const moved = {
          id_a: pair.id_a,
          id_b: pair.id_b,
          subject: pair.subject_a || pair.subject_b || pair.subject || 'unknown',
          contentType_a: pair.contentType_a,
          contentType_b: pair.contentType_b,
          content_a: pair.content_a,
          content_b: pair.content_b,
          sim_observed: pair.sim_observed,
          human_label: 'duplicate',
          rationale: rl.rationale,
          provenance: 'human_curated_relabel',
        }
        fixture.duplicate_pairs.push(moved)
        fixture.distinct_pairs.splice(idx, 1)
        movedToDup++
      } else if (rl.label === 'distinct') {
        // Confirm with stronger rationale
        pair.rationale = rl.rationale
        pair.provenance = 'human_curated_confirmed'
        confirmed++
      }
      found = true
    }

    if (!found) {
      idx = findPair(fixture.duplicate_pairs, pa, pb)
      if (idx >= 0) {
        const pair = fixture.duplicate_pairs[idx]
        if (rl.label === 'distinct') {
          const moved = {
            id_a: pair.id_a,
            id_b: pair.id_b,
            subject_a: pair.subject || 'unknown',
            subject_b: pair.subject || 'unknown',
            contentType_a: pair.contentType_a,
            contentType_b: pair.contentType_b,
            content_a: pair.content_a,
            content_b: pair.content_b,
            sim_observed: pair.sim_observed,
            human_label: 'distinct',
            rationale: rl.rationale,
            provenance: 'human_curated_relabel',
          }
          fixture.distinct_pairs.push(moved)
          fixture.duplicate_pairs.splice(idx, 1)
          movedToDistinct++
        } else {
          pair.rationale = rl.rationale
          pair.provenance = 'human_curated_confirmed'
          confirmed++
        }
        found = true
      }
    }

    if (!found) {
      console.warn(`  ⚠️  pair not found for relabel: ${pa} ↔ ${pb}`)
    }
  }

  fixture.notes = [
    ...(fixture.notes || []),
    `Human-curated relabel applied: ${movedToDup} pairs moved distinct→duplicate, ${movedToDistinct} pairs moved duplicate→distinct, ${confirmed} confirmed.`,
    'Human review checked the embedding-derived borderline cluster (cos 0.85-0.90) one-by-one. Several pairs that the heuristic flagged as "distinct" were in fact duplicates (refutations/restatements of the same fact). See test-fixtures/relabel-fixture.mjs for the per-pair reasoning.',
  ]
  fixture.relabeled_at = new Date().toISOString()

  await writeFile(fixturePath, JSON.stringify(fixture, null, 2))
  console.log(`✅ Relabel applied: distinct→duplicate=${movedToDup}, duplicate→distinct=${movedToDistinct}, confirmed=${confirmed}`)
  console.log(`   Final: duplicate_pairs=${fixture.duplicate_pairs.length}, distinct_pairs=${fixture.distinct_pairs.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
