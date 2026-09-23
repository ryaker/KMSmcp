/**
 * CLI: report on-read shadow rerank metrics from the decision logs.
 *
 *   npx tsx src/scripts/shadow-eval-report.ts [--target 200] [--k 5] \
 *       [--log <path> ...] [--labels <path>] [--since <iso>] [--json]
 *
 * Reads the personal log and the eng log by default, reports each and the combined set.
 * The promote gate is a sample count; everything that qualifies that count is printed
 * alongside it so the gate cannot be read on its own.
 *
 * Query text is NOT printed. The log is forced to 0600 precisely because a query can carry
 * anything the caller pasted — including a credential — so a report meant for a PR body or
 * a chat message treats it as sensitive and identifies runs by id and query hash instead.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  parseLabels,
  parseShadowLog,
  renderReport,
  summarize,
  unmatchedLabelKeys,
  type LabelSet,
  type ParsedShadowLog
} from '../eval/shadowRunMetrics.js'
import type { ShadowRunRecord } from '../decision/decisionLog.js'

const DEFAULT_PERSONAL = path.join(os.homedir(), '.kms', 'decision-log', 'recall-shadow.jsonl')
const DEFAULT_ENG = path.join(os.homedir(), '.kms', 'decision-log', 'eng-recall-shadow.jsonl')

export function arg(argv: string[], name: string, def?: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}

export function argAll(argv: string[], name: string): string[] {
  const out: string[] = []
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1]) out.push(argv[i + 1])
  })
  return out
}

function readLog(p: string): ParsedShadowLog | null {
  try {
    return parseShadowLog(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const target = Number(arg(argv, '--target', '200'))
  const k = Number(arg(argv, '--k', '5'))
  const since = arg(argv, '--since')
  const labelsPath = arg(argv, '--labels')
  const asJson = argv.includes('--json')

  const explicit = argAll(argv, '--log')
  const candidates = explicit.length
    ? explicit.map(f => ({ label: path.basename(f, '.jsonl'), file: f }))
    : [
        { label: 'personal', file: DEFAULT_PERSONAL },
        { label: 'eng', file: DEFAULT_ENG }
      ]

  const sources = candidates.map(c => ({ ...c, parsed: readLog(c.file) }))
  const present = sources.filter(s => s.parsed)
  if (!present.length) {
    console.error('no readable logs. looked for:')
    for (const s of sources) console.error(`  ${s.file}`)
    process.exit(2)
  }

  const sinceMs = since ? Date.parse(since) : null
  if (since && Number.isNaN(sinceMs)) {
    console.error(`--since is not a parseable date: ${since}`)
    process.exit(2)
  }

  const all: ShadowRunRecord[] = []
  let unordered = 0
  let malformed = 0
  let partialTail = 0
  for (const s of present) {
    for (const row of s.parsed!.rows) {
      if (sinceMs !== null) {
        const t = Date.parse(String(row.at))
        if (Number.isNaN(t) || t < sinceMs) continue
      }
      all.push(row)
    }
    unordered += s.parsed!.unorderedRuns
    malformed += s.parsed!.malformedLines
    partialTail += s.parsed!.partialTailLines
  }

  let labels: LabelSet | null = null
  if (labelsPath) {
    labels = parseLabels(fs.readFileSync(labelsPath, 'utf8'))
    const n = Object.keys(labels).length
    console.error(`labels: ${n} quer${n === 1 ? 'y' : 'ies'} loaded from ${labelsPath}`)
    if (n === 0) console.error('labels: file is empty — quality delta will not be computed')
  }

  const summary = summarize(all, { target, k, labels })
  summary.unorderedRuns = unordered
  summary.malformedLines = malformed
  summary.partialTailLines = partialTail

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  console.log(renderReport(sources, summary, { labelSetProvided: !!labelsPath }))

  // Diagnostic only, and hash-keyed: a label key that matches no run is usually a
  // whitespace or truncation mismatch, which is worth seeing without printing the query.
  if (labels) {
    const unmatched = unmatchedLabelKeys(labels, all)
    if (unmatched.length) {
      console.log('')
      console.log(
        `labels: ${unmatched.length} entr${unmatched.length === 1 ? 'y' : 'ies'} matched no run in these logs`
      )
      for (const u of unmatched.slice(0, 5)) console.log(`  ${u}`)
    }
  }
}

main().catch(e => {
  console.error('fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
