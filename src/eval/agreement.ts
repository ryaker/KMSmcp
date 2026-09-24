/**
 * Agreement statistics between two 0/1/2 labellers over the same (query, candidate) pairs
 * — used to measure how far Jev labels can be trusted against Gemma's existing grades
 * (`../scripts/jev-label-agreement.ts`). Pure functions, no network/filesystem: the caller
 * assembles `AgreementPair[]` from the two label sources.
 */

export const GRADES = [0, 1, 2] as const
export type Grade = (typeof GRADES)[number]

export type Source = 'eng' | 'personal' | 'prototype'
export type QueryKind = 'human' | 'agent-payload'

export interface AgreementPair {
  gemmaGrade: Grade
  jevGrade: Grade
  source: Source
  kind: QueryKind
}

// ── confusion matrix ────────────────────────────────────────────────────────

/** `matrix[gemmaGrade][jevGrade]` = count of pairs with that (gemma, jev) combination. */
export type ConfusionMatrix = [[number, number, number], [number, number, number], [number, number, number]]

export function confusionMatrix(pairs: readonly AgreementPair[]): ConfusionMatrix {
  const m: ConfusionMatrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (const p of pairs) m[p.gemmaGrade][p.jevGrade]++
  return m
}

function rowMarginals(m: ConfusionMatrix): [number, number, number] {
  return [m[0][0] + m[0][1] + m[0][2], m[1][0] + m[1][1] + m[1][2], m[2][0] + m[2][1] + m[2][2]]
}

function colMarginals(m: ConfusionMatrix): [number, number, number] {
  return [m[0][0] + m[1][0] + m[2][0], m[0][1] + m[1][1] + m[2][1], m[0][2] + m[1][2] + m[2][2]]
}

function total(m: ConfusionMatrix): number {
  return m.flat().reduce((a, b) => a + b, 0)
}

// ── exact agreement ──────────────────────────────────────────────────────────

export function exactAgreement(pairs: readonly AgreementPair[]): number {
  if (pairs.length === 0) return 0
  return pairs.filter(p => p.gemmaGrade === p.jevGrade).length / pairs.length
}

// ── binary agreement ─────────────────────────────────────────────────────────

export type BinaryMode = 'strict' | 'lenient'

export function isRelevantGrade(grade: Grade, mode: BinaryMode): boolean {
  return mode === 'strict' ? grade === 2 : grade >= 1
}

/** Fraction of pairs where the two labellers agree on the binary relevance call. */
export function binaryAgreement(pairs: readonly AgreementPair[], mode: BinaryMode): number {
  if (pairs.length === 0) return 0
  return pairs.filter(p => isRelevantGrade(p.gemmaGrade, mode) === isRelevantGrade(p.jevGrade, mode)).length / pairs.length
}

// ── Cohen's kappa ─────────────────────────────────────────────────────────────

/**
 * Unweighted Cohen's kappa: (po - pe) / (1 - pe), po = observed agreement (diagonal mass),
 * pe = agreement expected from the two labellers' marginals alone. Returns 0 (rather than
 * NaN) when `pe === 1` — only possible when every pair sits in one degenerate (row, col)
 * combination, an edge case only tiny test fixtures can hit; there is nothing "beyond
 * chance" to measure there.
 */
export function cohenKappaUnweighted(pairs: readonly AgreementPair[]): number {
  const m = confusionMatrix(pairs)
  const n = total(m)
  if (n === 0) return 0
  const rows = rowMarginals(m)
  const cols = colMarginals(m)
  const po = (m[0][0] + m[1][1] + m[2][2]) / n
  const pe = rows.reduce((s, r, i) => s + (r / n) * (cols[i] / n), 0)
  if (pe >= 1) return po >= 1 ? 1 : 0
  return (po - pe) / (1 - pe)
}

/**
 * Linearly-weighted Cohen's kappa over the ordinal 0/1/2 scale: weight(i, j) = 1 - |i-j|/2,
 * so adjacent-grade disagreement (0 vs 1, 1 vs 2) costs half as much as an opposite-ends
 * disagreement (0 vs 2). Standard construction (Cohen 1968) for a small ordered category
 * count (here 3, max distance 2).
 */
export function cohenKappaWeighted(pairs: readonly AgreementPair[]): number {
  const m = confusionMatrix(pairs)
  const n = total(m)
  if (n === 0) return 0
  const rows = rowMarginals(m)
  const cols = colMarginals(m)
  const maxDist = GRADES.length - 1 // 2
  const weight = (i: number, j: number): number => 1 - Math.abs(i - j) / maxDist

  let poW = 0
  let peW = 0
  for (let i = 0; i < GRADES.length; i++) {
    for (let j = 0; j < GRADES.length; j++) {
      const w = weight(i, j)
      poW += w * (m[i][j] / n)
      peW += w * (rows[i] / n) * (cols[j] / n)
    }
  }
  if (peW >= 1) return poW >= 1 ? 1 : 0
  return (poW - peW) / (1 - peW)
}

// ── slicing + summary ─────────────────────────────────────────────────────────

export interface AgreementSummary {
  slice: string
  n: number
  exactAgreement: number
  kappaUnweighted: number
  kappaWeighted: number
  binaryStrictAgreement: number
  binaryLenientAgreement: number
  confusion: ConfusionMatrix
}

export function summarizeAgreement(name: string, pairs: readonly AgreementPair[]): AgreementSummary {
  return {
    slice: name,
    n: pairs.length,
    exactAgreement: exactAgreement(pairs),
    kappaUnweighted: cohenKappaUnweighted(pairs),
    kappaWeighted: cohenKappaWeighted(pairs),
    binaryStrictAgreement: binaryAgreement(pairs, 'strict'),
    binaryLenientAgreement: binaryAgreement(pairs, 'lenient'),
    confusion: confusionMatrix(pairs),
  }
}

const SOURCES: readonly Source[] = ['eng', 'personal', 'prototype']
const KINDS: readonly QueryKind[] = ['human', 'agent-payload']

/** overall + one slice per source + one slice per query kind. Mirrors `sliceRows` in
 *  `../scripts/label-recall-pool.ts` so the two reports read the same way. */
export function sliceAgreementPairs(pairs: readonly AgreementPair[]): Record<string, AgreementPair[]> {
  const out: Record<string, AgreementPair[]> = { overall: [...pairs] }
  for (const source of SOURCES) out[`source:${source}`] = pairs.filter(p => p.source === source)
  for (const kind of KINDS) out[`kind:${kind}`] = pairs.filter(p => p.kind === kind)
  return out
}

export function buildAgreementReport(pairs: readonly AgreementPair[]): AgreementSummary[] {
  const slices = sliceAgreementPairs(pairs)
  return Object.entries(slices).map(([name, slicePairs]) => summarizeAgreement(name, slicePairs))
}

function fmt(x: number): string {
  return x.toFixed(4)
}

export function renderAgreementReport(summaries: readonly AgreementSummary[]): string {
  const lines: string[] = []
  lines.push('Jev label agreement vs Gemma grade (60-query prototype pool + 29-query pool)')
  lines.push('')
  for (const s of summaries) {
    lines.push(`[${s.slice}]  n=${s.n}`)
    if (s.n === 0) {
      lines.push('  (no pairs in this slice)')
      continue
    }
    lines.push(`  exact agreement        ${fmt(s.exactAgreement)}`)
    lines.push(`  kappa (unweighted)      ${fmt(s.kappaUnweighted)}`)
    lines.push(`  kappa (linear-weighted) ${fmt(s.kappaWeighted)}`)
    lines.push(`  binary strict  (2 vs <2) agreement  ${fmt(s.binaryStrictAgreement)}`)
    lines.push(`  binary lenient (>=1 vs 0) agreement ${fmt(s.binaryLenientAgreement)}`)
    lines.push(
      `  confusion[gemma][jev]  0:[${s.confusion[0].join(',')}]  1:[${s.confusion[1].join(',')}]  2:[${s.confusion[2].join(',')}]`
    )
    lines.push('')
  }
  return lines.join('\n')
}
