#!/usr/bin/env node
/**
 * analyze-thresholds.mjs — DG-INV-2 Deliverable 2
 *
 * Empirical threshold recommendation. Reads dedup-calibration.json,
 * embeds every entry's content via Ollama nomic-embed-text, computes
 * cosine sim per pair, and reports separation stats.
 *
 * Outputs printed to stdout (captured for the report).
 *
 * Run: node test-fixtures/analyze-thresholds.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OLLAMA_URL = 'http://127.0.0.1:11434/api/embeddings'
const EMBED_MODEL = 'nomic-embed-text'

async function embed(text) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  })
  if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`)
  const data = await res.json()
  return data.embedding
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

function stats(arr) {
  if (arr.length === 0) return { n: 0 }
  const sorted = [...arr].sort((a, b) => a - b)
  const sum = arr.reduce((a, b) => a + b, 0)
  return {
    n: arr.length,
    min: sorted[0],
    p10: quantile(sorted, 0.10),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.50),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.90),
    max: sorted[sorted.length - 1],
    mean: sum / arr.length,
  }
}

function fmtStats(s) {
  if (s.n === 0) return 'no data'
  return `n=${s.n} min=${s.min.toFixed(3)} p10=${s.p10.toFixed(3)} p25=${s.p25.toFixed(3)} median=${s.median.toFixed(3)} p75=${s.p75.toFixed(3)} p90=${s.p90.toFixed(3)} max=${s.max.toFixed(3)} mean=${s.mean.toFixed(3)}`
}

function asciiHistogram(values, binCount = 20, label = '') {
  if (values.length === 0) return `${label}: (no data)\n`
  const min = 0.5
  const max = 1.0
  const binWidth = (max - min) / binCount
  const bins = new Array(binCount).fill(0)
  for (const v of values) {
    if (v < min || v > max) continue
    let idx = Math.floor((v - min) / binWidth)
    if (idx >= binCount) idx = binCount - 1
    bins[idx]++
  }
  const maxBin = Math.max(...bins, 1)
  const lines = [`${label} (n=${values.length}, range [${min}-${max}], ${binCount} bins)`]
  for (let i = 0; i < binCount; i++) {
    const lo = (min + i * binWidth).toFixed(3)
    const hi = (min + (i + 1) * binWidth).toFixed(3)
    const bar = '█'.repeat(Math.round((bins[i] / maxBin) * 40))
    lines.push(`  ${lo}–${hi}  ${bins[i].toString().padStart(3)} ${bar}`)
  }
  return lines.join('\n')
}

function findOptimalThreshold(dupSims, distinctSims) {
  // Brute-force search 0.5–0.99 step 0.005
  let bestF1 = 0
  let bestT = 0.85
  let bestPrecision = 0
  let bestRecall = 0
  const allTs = []
  for (let t = 0.50; t < 1.00; t += 0.005) {
    const tp = dupSims.filter(s => s >= t).length      // dup classified as dup
    const fn = dupSims.length - tp                      // dup missed
    const fp = distinctSims.filter(s => s >= t).length // distinct flagged dup
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 1
    const recall = dupSims.length > 0 ? tp / dupSims.length : 0
    const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0
    allTs.push({ t, tp, fn, fp, precision, recall, f1 })
    if (f1 > bestF1) { bestF1 = f1; bestT = t; bestPrecision = precision; bestRecall = recall }
  }

  // Also: lowest threshold with zero false positives (refuse threshold candidate)
  let zeroFPThreshold = null
  let zeroFPRecall = 0
  for (let t = 1.00; t >= 0.50; t -= 0.005) {
    const fp = distinctSims.filter(s => s >= t).length
    const tp = dupSims.filter(s => s >= t).length
    if (fp === 0) {
      zeroFPThreshold = t
      zeroFPRecall = tp / Math.max(1, dupSims.length)
    } else {
      break
    }
  }

  // Highest threshold capturing 90% of duplicates (recall threshold candidate)
  let recall90Threshold = null
  for (let t = 1.00; t >= 0.50; t -= 0.005) {
    const tp = dupSims.filter(s => s >= t).length
    const recall = tp / Math.max(1, dupSims.length)
    if (recall >= 0.90) {
      recall90Threshold = t
      break
    }
  }

  return { bestF1, bestT, bestPrecision, bestRecall, zeroFPThreshold, zeroFPRecall, recall90Threshold, curve: allTs }
}

async function main() {
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k]

  const fixturePath = join(__dirname, 'dedup-calibration.json')
  const raw = await readFile(fixturePath, 'utf-8')
  const fixture = JSON.parse(raw)

  console.log(`# Threshold Calibration Analysis`)
  console.log(`Fixture: ${fixturePath}`)
  console.log(`Embedder: ${fixture.embedder} (${fixture.embedder_dim}d)`)
  console.log(`Generated: ${fixture.generated_at}`)
  console.log(`Corpus size at gen: ${fixture.kms_corpus_size_at_generation}`)
  console.log(`duplicate_pairs: ${fixture.duplicate_pairs.length}`)
  console.log(`distinct_pairs:  ${fixture.distinct_pairs.length}`)
  console.log()

  // Build embedding cache: each unique content → embedding
  const cache = new Map()
  async function getEmb(text) {
    const key = text.slice(0, 200) + '...' + text.length
    if (cache.has(key)) return cache.get(key)
    const v = await embed(text.slice(0, 4000))
    cache.set(key, v)
    return v
  }

  console.log('Embedding all pair contents...')
  const t0 = Date.now()
  const dupSims = []
  const dupRows = [] // for per-contentType breakdown
  for (const p of fixture.duplicate_pairs) {
    const a = await getEmb(p.content_a || '')
    const b = await getEmb(p.content_b || '')
    const sim = cosine(a, b)
    dupSims.push(sim)
    dupRows.push({ ...p, sim })
  }
  const distinctSims = []
  const distinctRows = []
  for (const p of fixture.distinct_pairs) {
    const a = await getEmb(p.content_a || '')
    const b = await getEmb(p.content_b || '')
    const sim = cosine(a, b)
    distinctSims.push(sim)
    distinctRows.push({ ...p, sim })
  }
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${cache.size} unique embeddings)`)
  console.log()

  // Overall stats
  console.log('## Overall similarity distributions')
  console.log()
  console.log('### duplicate_pairs:')
  console.log(`  ${fmtStats(stats(dupSims))}`)
  console.log()
  console.log('### distinct_pairs:')
  console.log(`  ${fmtStats(stats(distinctSims))}`)
  console.log()

  console.log('### Histograms')
  console.log(asciiHistogram(dupSims, 20, 'duplicate_pairs cosine distribution'))
  console.log()
  console.log(asciiHistogram(distinctSims, 20, 'distinct_pairs cosine distribution'))
  console.log()

  // Threshold optimization
  console.log('## Threshold optimization')
  const opt = findOptimalThreshold(dupSims, distinctSims)
  console.log(`  Best F1: ${opt.bestF1.toFixed(3)} at threshold ${opt.bestT.toFixed(3)} (precision=${opt.bestPrecision.toFixed(3)}, recall=${opt.bestRecall.toFixed(3)})`)
  if (opt.zeroFPThreshold !== null) {
    console.log(`  Zero-false-positive threshold: ${opt.zeroFPThreshold.toFixed(3)} (recall=${opt.zeroFPRecall.toFixed(3)})`)
  } else {
    console.log(`  Zero-false-positive threshold: NONE (false positives at every threshold)`)
  }
  if (opt.recall90Threshold !== null) {
    console.log(`  90%-recall threshold: ${opt.recall90Threshold.toFixed(3)}`)
  }
  console.log()

  // Threshold curve table
  console.log('### Threshold sweep (selected rows)')
  console.log('  threshold | TP | FN | FP | precision | recall | F1')
  for (const t of [0.95, 0.92, 0.90, 0.87, 0.85, 0.82, 0.80, 0.78, 0.75, 0.72, 0.70]) {
    const row = opt.curve.find(r => Math.abs(r.t - t) < 0.0025)
    if (!row) continue
    console.log(`  ${row.t.toFixed(3)}     | ${String(row.tp).padStart(2)} | ${String(row.fn).padStart(2)} | ${String(row.fp).padStart(2)} | ${row.precision.toFixed(3)}     | ${row.recall.toFixed(3)}  | ${row.f1.toFixed(3)}`)
  }
  console.log()

  // Per-contentType breakdown
  console.log('## Per-contentType breakdown')
  const types = new Set([
    ...dupRows.map(r => r.contentType_a),
    ...dupRows.map(r => r.contentType_b),
    ...distinctRows.map(r => r.contentType_a),
    ...distinctRows.map(r => r.contentType_b),
  ])
  for (const t of types) {
    const dT = dupRows.filter(r => r.contentType_a === t || r.contentType_b === t).map(r => r.sim)
    const xT = distinctRows.filter(r => r.contentType_a === t || r.contentType_b === t).map(r => r.sim)
    if (dT.length === 0 && xT.length === 0) continue
    console.log(`  ${t}:`)
    console.log(`    dup     ${fmtStats(stats(dT))}`)
    console.log(`    distinct ${fmtStats(stats(xT))}`)
  }
  console.log()

  // Provenance breakdown — supersede chains are gold; let's see how they cluster.
  console.log('## By provenance (duplicate_pairs)')
  const provs = new Set(dupRows.map(r => r.provenance))
  for (const prov of provs) {
    const sub = dupRows.filter(r => r.provenance === prov).map(r => r.sim)
    console.log(`  ${prov}: ${fmtStats(stats(sub))}`)
  }
  console.log()

  console.log('## By provenance (distinct_pairs)')
  const provsX = new Set(distinctRows.map(r => r.provenance))
  for (const prov of provsX) {
    const sub = distinctRows.filter(r => r.provenance === prov).map(r => r.sim)
    console.log(`  ${prov}: ${fmtStats(stats(sub))}`)
  }
  console.log()

  // Edge case: list any duplicates with sim < 0.80 (these are problematic)
  const lowSimDups = dupRows.filter(r => r.sim < 0.80).sort((a, b) => a.sim - b.sim)
  if (lowSimDups.length > 0) {
    console.log('## ⚠️  Duplicate pairs with cos < 0.80 (gate would miss these)')
    for (const r of lowSimDups) {
      console.log(`  sim=${r.sim.toFixed(3)} (${r.provenance}) ${r.id_a.slice(0, 8)} ↔ ${r.id_b.slice(0, 8)}`)
      console.log(`    A: ${(r.content_a || '').slice(0, 100)}`)
      console.log(`    B: ${(r.content_b || '').slice(0, 100)}`)
    }
    console.log()
  }

  // Edge case: list any distinct pairs with sim ≥ 0.85 (false-positive risk)
  const highSimDistinct = distinctRows.filter(r => r.sim >= 0.85).sort((a, b) => b.sim - a.sim)
  if (highSimDistinct.length > 0) {
    console.log('## ⚠️  Distinct pairs with cos ≥ 0.85 (gate would falsely refuse these)')
    for (const r of highSimDistinct) {
      console.log(`  sim=${r.sim.toFixed(3)} (${r.provenance}) ${r.id_a.slice(0, 8)} ↔ ${r.id_b.slice(0, 8)}`)
      console.log(`    A: ${(r.content_a || '').slice(0, 100)}`)
      console.log(`    B: ${(r.content_b || '').slice(0, 100)}`)
    }
    console.log()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
