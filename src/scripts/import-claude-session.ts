/**
 * Claude Code session transcript → KMS review-queue importer.
 *
 * Mines the ending session's JSONL transcript (~/.claude/projects/<slug>/<session>.jsonl)
 * for high-signal user turns, has Jev (TypeSafe System One, `jev-1.13.0` — see
 * src/decision/JevDecisionEngine.ts) triage each one with small atomic nouls, and writes
 * the top-scoring turns to the KMS review queue (`unified_store` with `review: "candidate"`)
 * so they are held for human approval (`kms_review`) rather than injected live.
 *
 * Mirrors the existing importers' shape (src/scripts/import-slack-huddles.ts,
 * src/scripts/import-md-corpus.ts): a pure extraction/scoring core (testable, no network)
 * plus a thin CLI that talks to KMS over MCP-over-HTTP via `MinimalMcpClient` — the same
 * helper those importers use, so secret scrubbing, dedup, and routing all run server-side.
 *
 *   npx tsx src/scripts/import-claude-session-cli.ts \
 *     --transcript ~/.claude/projects/-Users-ryaker-Dev-KMSmcp/<session>.jsonl \
 *     --cwd ~/Dev/KMSmcp [--dry-run] [--max 5] [--threshold 0.6] [--no-review]
 *
 * (This module is import-only / side-effect-free — see the bottom of the file. The CLI
 * entry point is `import-claude-session-cli.ts`.)
 *
 * Jev is used for classification even in --dry-run (cheap, no side effect); only the
 * `unified_store` write is skipped when --dry-run is set. Every `dedup_required` response
 * is skipped and logged — never forced (see CLAUDE.md "Dedup gate").
 *
 * HARD RULE: nothing Sophia-related (the MyMoneyCoach.ai persona) may enter eng_kms or
 * personal_kms (docs/... project memory `project_sophia_isolation`). Dropped whenever
 * EITHER of two independent checks fires: the `mentions_sophia` noul over threshold, OR a
 * code-side `/sophia/i` regex over the raw turn text — the regex cannot be talked out of
 * by a mis-scored judgment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { MinimalMcpClient } from './import-slack-huddles.js'
import { createJevDecisionEngineFromEnv } from '../decision/JevDecisionEngine.js'
import { withEngineSlot } from '../decision/engineSlot.js'
import type { DecisionEngine, NoulDecisionQuestion } from '../decision/types.js'

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

export const MIN_CONTENT_CHARS = 40
export const MAX_USER_CHARS = 600
export const MAX_ASSISTANT_CHARS = 200
export const MAX_PREVIOUS_ASSISTANT_CHARS = 600
export const DEFAULT_MAX_KEEP = 5
export const DEFAULT_KEEP_THRESHOLD = 0.6
export const SOPHIA_NOUL_THRESHOLD = 0.3

/** HARD RULE — see module docstring. Never talked out of by a judgment. */
export const SOPHIA_RE = /sophia/i

/** Harness-injected or machine-generated user turns — never Rich's words. */
const NOISE_PREFIXES = [
  '<system-reminder',
  '<command-',
  '<local-command',
  '<task-notification',
  '<user-prompt-submit-hook',
  '<ide_',
  '<bash-',
  '[Request interrupted',
  'Caveat:',
  '<pasted_content',
  '<channel',
  '[Artifact comment',
  'Stop hook feedback',
  'This session is being continued',
  '# Chief of Staff',
  'Base directory for this skill',
  // Subagent hand-backs and cross-session messages arrive as user turns but were not typed by the user
  'Another Claude session sent a message',
  '<agent-message',
  '<cross-session-message'
]

/**
 * Hook-injected KMS recall context (see examples/hooks/kms-context-inject.sh /
 * kms_context_format.py) is wrapped in a nonce-bounded marker block:
 *   [ENG-KMS Memory Context #1a2b3c4d] ... [End ENG-KMS Context #1a2b3c4d]
 *   [KMS Memory Context #1a2b3c4d] ... [End KMS Context #1a2b3c4d]
 * Strip the whole block — it is retrieval evidence Claude Code injected, not the user's
 * own words.
 */
const INJECTED_CONTEXT_RE =
  /\[[^\]\n]*Memory Context #[0-9a-fA-F]+\][\s\S]*?\[End [^\]\n]*Context #[0-9a-fA-F]+\]/g

export function stripInjectedContext(text: string): string {
  return text.replace(INJECTED_CONTEXT_RE, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isNoiseText(text: string): boolean {
  return NOISE_PREFIXES.some(p => text.startsWith(p))
}

// ─────────────────────────────────────────────────────────────────────────
// Transcript parsing (pure, no network)
// ─────────────────────────────────────────────────────────────────────────

export interface TurnUnit {
  /** The user's words, injected-context stripped and trimmed. */
  userMessage: string
  /** Last assistant text block (no tool output) before the next user turn, or null. */
  assistantExcerpt: string | null
  /** Last assistant text before this user turn — what a correction would be correcting. */
  previousAssistantExcerpt: string | null
  /** ISO timestamp of the user turn, if the transcript line had one. */
  timestamp: string | null
  uuid: string | null
  /** 1-based line number in the transcript — the watermark unit. */
  line: number
}

function rawUserText(message: any): string | null {
  const c = message?.content
  let text: string
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    // Tool results arrive wrapped in a "user" role turn — not Rich's words.
    if (c.some((b: any) => b?.type === 'tool_result')) return null
    text = c
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text ?? '')
      .join('\n')
  } else return null
  text = text.trim()
  return text || null
}

function assistantTextBlocks(message: any): string[] {
  const c = message?.content
  if (!Array.isArray(c)) return []
  return c
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => String(b.text ?? '').trim())
    .filter(Boolean)
}

interface OpenTurn {
  userMessage: string
  previousAssistantText: string | null
  timestamp: string | null
  uuid: string | null
  line: number
  assistantTexts: string[]
}

/**
 * Parse a Claude Code session transcript (JSONL) into candidate turn units: one per
 * user-typed message, paired with the last assistant text reply before the next user
 * turn. Skips tool results, subagent (isSidechain) turns, hook-injected/system-reminder
 * turns, and anything under MIN_CONTENT_CHARS after stripping injected context.
 */
export function extractTurnUnits(absTranscriptPath: string): TurnUnit[] {
  const lines = readFileSync(absTranscriptPath, 'utf8').split('\n')
  const units: TurnUnit[] = []
  let current: OpenTurn | null = null
  let lastAssistantText: string | null = null

  const flush = () => {
    if (!current) return
    const userMessage = stripInjectedContext(current.userMessage)
    if (userMessage.length >= MIN_CONTENT_CHARS && !isNoiseText(userMessage)) {
      units.push({
        userMessage,
        assistantExcerpt:
          current.assistantTexts.length > 0
            ? current.assistantTexts[current.assistantTexts.length - 1]
            : null,
        previousAssistantExcerpt: current.previousAssistantText,
        timestamp: current.timestamp,
        uuid: current.uuid,
        line: current.line
      })
    }
    current = null
  }

  lines.forEach((raw, i) => {
    if (!raw) return
    let d: any
    try {
      d = JSON.parse(raw)
    } catch {
      return
    }

    if (d.type === 'assistant' && !d.isSidechain) {
      const texts = assistantTextBlocks(d.message)
      if (texts.length) {
        lastAssistantText = texts[texts.length - 1]
        if (current) current.assistantTexts.push(...texts)
      }
      return
    }
    if (d.type !== 'user' || d.isSidechain) return

    const text = rawUserText(d.message)
    if (text === null) return

    flush()
    current = {
      userMessage: text,
      previousAssistantText: lastAssistantText,
      timestamp: typeof d.timestamp === 'string' ? d.timestamp : null,
      uuid: typeof d.uuid === 'string' ? d.uuid : null,
      line: i + 1,
      assistantTexts: []
    }
  })
  flush()

  return units
}

// ─────────────────────────────────────────────────────────────────────────
// Jev triage — small state, atomic nouls
// ─────────────────────────────────────────────────────────────────────────

export const SESSION_NOULS = [
  'states_standing_rule',
  'corrects_assistant',
  'decision_with_reason',
  'verified_fact_or_fix',
  'ephemeral',
  'mentions_sophia'
] as const

export type SessionNoul = (typeof SESSION_NOULS)[number]

const DURABLE_NOULS = [
  'states_standing_rule',
  'corrects_assistant',
  'decision_with_reason',
  'verified_fact_or_fix'
] as const satisfies readonly SessionNoul[]

export type TopKind = (typeof DURABLE_NOULS)[number]

export const SESSION_QUESTIONS: Record<SessionNoul, NoulDecisionQuestion> = {
  states_standing_rule: {
    type: 'noul',
    instructions:
      'Does `user_message` state a rule, preference, or default that should apply to future work, not only to this one request?',
    criteria: {
      true: 'A lasting rule or preference: "always…", "never…", "X should run on Y", "from now on…", or a stated default',
      false: 'Only a request, question, or instruction for the task at hand'
    }
  },
  corrects_assistant: {
    type: 'noul',
    instructions:
      'Does `user_message` push back on, disagree with, or correct something said, assumed, or done in `previous_assistant_message`?',
    criteria: {
      true: 'Disagrees with, rejects, or corrects a claim, assumption, or action of the assistant',
      false: 'Agrees, asks something new, or gives an instruction without disputing the assistant'
    }
  },
  decision_with_reason: {
    type: 'noul',
    instructions:
      'Does `user_message` make or confirm a concrete decision (an approach, architecture, or plan) together with the reason for it?'
  },
  verified_fact_or_fix: {
    type: 'noul',
    instructions:
      'Do `user_message` and `assistant_reply` together record a concrete technical fact or fix that was checked and confirmed, not a hypothesis or guess?'
  },
  ephemeral: {
    type: 'noul',
    instructions: 'Is `user_message` only about the task in progress, with nothing worth remembering in a later session?',
    criteria: {
      true: 'Status check, go-ahead, routine one-off request, or chatter ("run the tests", "status?", "proceed")',
      false: 'Contains a rule, preference, correction, decision, or fact that would still matter in a later session, however it is phrased'
    }
  },
  mentions_sophia: {
    type: 'noul',
    instructions:
      'Is `user_message` or `assistant_reply` specifically about the "Sophia" AI coach persona or the MyMoneyCoach.ai character? The unrelated name "Sofia" does not count.'
  }
}

export function computeScore(nouls: Record<SessionNoul, number>): number {
  const durable = Math.max(...DURABLE_NOULS.map(k => nouls[k]))
  return durable * (1 - nouls.ephemeral)
}

export function topDurableKind(nouls: Record<SessionNoul, number>): TopKind {
  let best: TopKind = DURABLE_NOULS[0]
  for (const k of DURABLE_NOULS) if (nouls[k] > nouls[best]) best = k
  return best
}

/** HARD RULE gate: mentions_sophia noul OR the code-side regex, over either side of the turn. */
export function isSophia(unit: TurnUnit, nouls: Record<SessionNoul, number>): boolean {
  if (nouls.mentions_sophia > SOPHIA_NOUL_THRESHOLD) return true
  if (SOPHIA_RE.test(unit.userMessage)) return true
  if (unit.assistantExcerpt && SOPHIA_RE.test(unit.assistantExcerpt)) return true
  return false
}

export interface JevClassifyResult {
  nouls: Record<SessionNoul, number>
  usage: { inputTokens: number; outputTokens: number }
  latencyMs: number
  costUsdEstimate: number | null
}

export interface SessionJevClient {
  classify(state: {
    previous_assistant_message: string | null
    user_message: string
    assistant_reply: string | null
  }): Promise<JevClassifyResult>
}

/** Real Jev-backed client — one `evaluate()` per turn, rate-limited by the shared engine slot. */
export class EngineSessionJevClient implements SessionJevClient {
  constructor(private readonly engine: DecisionEngine) {}

  async classify(state: {
    previous_assistant_message: string | null
    user_message: string
    assistant_reply: string | null
  }): Promise<JevClassifyResult> {
    const result = await withEngineSlot(() =>
      this.engine.evaluate({ state, questions: SESSION_QUESTIONS })
    )
    const nouls = {} as Record<SessionNoul, number>
    for (const id of SESSION_NOULS) {
      const a = result.answers[id]
      if (!a || a.type !== 'noul') {
        throw new Error(`jev: session noul "${id}" missing or malformed`)
      }
      nouls[id] = a.probability
    }
    return {
      nouls,
      usage: result.usage,
      latencyMs: result.latencyMs,
      costUsdEstimate: result.costUsdEstimate
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Scoring + ranking
// ─────────────────────────────────────────────────────────────────────────

export interface ScoredUnit {
  unit: TurnUnit
  nouls: Record<SessionNoul, number>
  score: number
  topKind: TopKind
}

export interface ScoreStats {
  scored: ScoredUnit[]
  jevCalls: number
  sophiaDropped: number
  totalCostUsd: number
  totalLatencyMs: number
}

/** One Jev request per turn unit, serially (modest concurrency — reuses the shared token bucket). */
export async function scoreUnits(units: TurnUnit[], jev: SessionJevClient): Promise<ScoreStats> {
  const scored: ScoredUnit[] = []
  let sophiaDropped = 0
  let totalCostUsd = 0
  let totalLatencyMs = 0

  for (const unit of units) {
    const state = {
      // Tail of the prior reply: the part a correction usually reacts to. Kept short (R4).
      previous_assistant_message: unit.previousAssistantExcerpt
        ? unit.previousAssistantExcerpt.slice(-MAX_PREVIOUS_ASSISTANT_CHARS)
        : null,
      user_message: unit.userMessage.slice(0, MAX_USER_CHARS),
      assistant_reply: unit.assistantExcerpt
        ? unit.assistantExcerpt.slice(0, MAX_ASSISTANT_CHARS)
        : null
    }
    const result = await jev.classify(state)
    totalCostUsd += result.costUsdEstimate ?? 0
    totalLatencyMs += result.latencyMs

    if (isSophia(unit, result.nouls)) {
      sophiaDropped++
      continue
    }
    scored.push({
      unit,
      nouls: result.nouls,
      score: computeScore(result.nouls),
      topKind: topDurableKind(result.nouls)
    })
  }

  return { scored, jevCalls: units.length, sophiaDropped, totalCostUsd, totalLatencyMs }
}

export function rankAndKeep(
  scored: ScoredUnit[],
  opts: { threshold: number; max: number }
): ScoredUnit[] {
  return [...scored]
    .filter(s => s.score >= opts.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.max)
}

// ─────────────────────────────────────────────────────────────────────────
// Content + store args
// ─────────────────────────────────────────────────────────────────────────

export function contentTypeForTopKind(topKind: TopKind): 'pattern' | 'insight' | 'fact' {
  switch (topKind) {
    case 'states_standing_rule':
    case 'corrects_assistant':
      return 'pattern'
    case 'decision_with_reason':
      return 'insight'
    case 'verified_fact_or_fix':
      return 'fact'
  }
}

export function buildContextPrefix(unit: TurnUnit, project: string): string {
  const date = unit.timestamp && unit.timestamp.length >= 10 ? unit.timestamp.slice(0, 10) : 'unknown-date'
  return `[Claude session ${date}, ${project}]`
}

/** User message verbatim (trimmed) plus a one-line context prefix; decision/fix units also get a short assistant excerpt. */
export function buildContent(unit: TurnUnit, topKind: TopKind, project: string): string {
  const prefix = buildContextPrefix(unit, project)
  const user = unit.userMessage.slice(0, MAX_USER_CHARS).trim()
  let content = `${prefix} ${user}`
  // A standing rule stands alone; a correction, decision, or fix needs the reply for context.
  const wantsExcerpt = topKind !== 'states_standing_rule'
  if (wantsExcerpt && unit.assistantExcerpt) {
    const excerpt = unit.assistantExcerpt.slice(0, MAX_ASSISTANT_CHARS).trim()
    if (excerpt) content += `\nAssistant: ${excerpt}`
  }
  return content
}

export interface StoreContext {
  project: string
  sessionId: string
  userId: string
  source: 'personal' | 'technical'
  review: boolean
}

/** Args for `unified_store`. Subject is per-topKind so the dedup gate scopes within it. */
export function buildStoreArgs(
  unit: TurnUnit,
  nouls: Record<SessionNoul, number>,
  topKind: TopKind,
  ctx: StoreContext
): Record<string, any> {
  return {
    ...(ctx.review ? { review: 'candidate' as const } : {}),
    content: buildContent(unit, topKind, ctx.project),
    contentType: contentTypeForTopKind(topKind),
    source: ctx.source,
    userId: ctx.userId,
    writeMode: 'standard' as const,
    ...(unit.timestamp ? { timestamp: unit.timestamp } : {}),
    metadata: {
      subject: `ClaudeSession.${topKind}`,
      source: 'claude-session',
      session_id: ctx.sessionId,
      project: ctx.project,
      jev_scores: nouls
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Routing — mirrors examples/hooks/kms-context-inject.sh's is_eng_cwd
// ─────────────────────────────────────────────────────────────────────────

export function projectFromCwd(cwd: string): string {
  return basename(cwd.replace(/\/+$/, '')) || 'unknown-project'
}

export function isEngCwd(cwd: string, home: string = homedir()): boolean {
  const engDevHome = join(home, 'Dev')
  return (
    cwd === '/Volumes/Dev' ||
    cwd.startsWith('/Volumes/Dev/') ||
    cwd === engDevHome ||
    cwd.startsWith(`${engDevHome}/`) ||
    cwd === '/Users/ryaker/Dev' ||
    cwd.startsWith('/Users/ryaker/Dev/')
  )
}

export interface Route {
  kmsUrl: string
  userId: string
  source: 'personal' | 'technical'
}

export function routeForCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): Route {
  if (isEngCwd(cwd)) {
    return {
      kmsUrl: env.KMS_ENG_URL || 'http://localhost:8181/mcp',
      userId: env.KMS_ENG_USER_ID || 'eng_kms',
      source: 'technical'
    }
  }
  return {
    kmsUrl: env.KMS_PERSONAL_URL || 'http://localhost:8180/mcp',
    userId: env.KMS_PERSONAL_USER_ID || 'richard_yaker',
    source: 'personal'
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Watermark — ~/.kms-session-import/<session_id>.json
// ─────────────────────────────────────────────────────────────────────────

export interface Watermark {
  /** Highest transcript line number ever considered (parsed) for this session. */
  lastLine: number
  lastRun?: string
}

export function watermarkDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KMS_SESSION_IMPORT_DIR || join(homedir(), '.kms-session-import')
}

export function watermarkPath(sessionId: string, dir: string): string {
  return join(dir, `${sessionId}.json`)
}

export function loadWatermark(path: string): Watermark {
  if (!existsSync(path)) return { lastLine: 0 }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed.lastLine === 'number') {
      return { lastLine: parsed.lastLine, lastRun: parsed.lastRun }
    }
  } catch {
    // Malformed watermark — treat as absent rather than fail the run.
  }
  return { lastLine: 0 }
}

export function saveWatermark(path: string, wm: Watermark): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ lastLine: wm.lastLine, lastRun: new Date().toISOString() }, null, 2),
    'utf8'
  )
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

export interface CliOptions {
  transcript: string
  cwd: string
  dryRun: boolean
  max: number
  threshold: number
  review: boolean
  kmsUrl?: string
  userId?: string
  bearerToken?: string
  watermarkDir?: string
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: Partial<CliOptions> = {
    dryRun: false,
    max: DEFAULT_MAX_KEEP,
    threshold: DEFAULT_KEEP_THRESHOLD,
    review: true
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--transcript':
        opts.transcript = next()
        break
      case '--cwd':
        opts.cwd = next()
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--max':
        opts.max = parseInt(next(), 10)
        break
      case '--threshold':
        opts.threshold = parseFloat(next())
        break
      case '--no-review':
        opts.review = false
        break
      case '--kms-url':
        opts.kmsUrl = next()
        break
      case '--user-id':
        opts.userId = next()
        break
      case '--bearer-token':
        opts.bearerToken = next()
        break
      case '--watermark-dir':
        opts.watermarkDir = next()
        break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`)
    }
  }
  if (!opts.transcript) throw new Error('--transcript <path> is required')
  if (!opts.cwd) throw new Error('--cwd <dir> is required')
  return opts as CliOptions
}

function printHelp(): void {
  console.log(`
Claude Code session → KMS review-queue importer

Usage:
  node dist/scripts/import-claude-session-cli.js --transcript <path> --cwd <dir> [options]

Options:
  --transcript <path>   Path to the session's JSONL transcript (required).
  --cwd <dir>            The session's working directory — routes eng_kms vs
                         personal (mirrors examples/hooks/kms-context-inject.sh).
  --dry-run              Classify with Jev but don't write to KMS.
  --max <N>               Cap kept entries (default ${DEFAULT_MAX_KEEP}).
  --threshold <0..1>      Minimum score to keep (default ${DEFAULT_KEEP_THRESHOLD}).
  --no-review             Write live instead of to the review queue (kms_review).
  --kms-url <url>         Override the routed KMS URL.
  --user-id <id>          Override the routed userId.
  --bearer-token <token>  KMS OAuth bearer token. Or set KMS_BEARER_TOKEN.
  --watermark-dir <dir>   Override ~/.kms-session-import.
  -h, --help              This help.

Environment:
  ONECLI_TOKEN / ONECLI_GATEWAY   Jev credential route (preferred).
  TYPESAFE_API_KEY                Direct Jev credential (fallback).
  KMS_BEARER_TOKEN                KMS OAuth bearer token.
  KMS_ENG_URL / KMS_ENG_USER_ID           Override eng-kms routing.
  KMS_PERSONAL_URL / KMS_PERSONAL_USER_ID Override personal-kms routing.
  KMS_SESSION_IMPORT_DIR          Override the watermark directory.
`)
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────

export interface SessionImportReport {
  sessionId: string
  project: string
  turnsParsed: number
  turnsConsidered: number
  jevCalls: number
  sophiaDropped: number
  kept: number
  stored: number
  dedupSkipped: number
  failed: number
  totalCostUsd: number
  totalLatencyMs: number
  keptPreview: Array<{
    contentPreview: string
    score: number
    topKind: TopKind
    stored: boolean
  }>
}

export async function runSessionImport(
  opts: CliOptions,
  deps: { jev: SessionJevClient; kms: MinimalMcpClient | null }
): Promise<SessionImportReport> {
  const sessionId = basename(opts.transcript, '.jsonl')
  const project = projectFromCwd(opts.cwd)
  const route = routeForCwd(opts.cwd)
  const userId = opts.userId || route.userId
  const source = route.source

  const wmDir = opts.watermarkDir || watermarkDir()
  const wmPath = watermarkPath(sessionId, wmDir)
  const wm = loadWatermark(wmPath)

  const allUnits = extractTurnUnits(opts.transcript)
  const newUnits = allUnits.filter(u => u.line > wm.lastLine)

  const scoreStats = await scoreUnits(newUnits, deps.jev)
  const kept = rankAndKeep(scoreStats.scored, { threshold: opts.threshold, max: opts.max })

  let stored = 0
  let dedupSkipped = 0
  let failed = 0
  const keptPreview: SessionImportReport['keptPreview'] = []

  for (const s of kept) {
    const args = buildStoreArgs(s.unit, s.nouls, s.topKind, {
      project,
      sessionId,
      userId,
      source,
      review: opts.review
    })
    const preview = {
      contentPreview: String(args.content).slice(0, 100),
      score: s.score,
      topKind: s.topKind,
      stored: false
    }

    if (opts.dryRun || !deps.kms) {
      keptPreview.push(preview)
      continue
    }

    try {
      const result: any = await deps.kms.callTool('unified_store', args)
      if (result?.status === 'dedup_required') {
        dedupSkipped++
        console.warn(`dedup_required — skipping (never forcing): ${preview.contentPreview}`)
      } else if (result?.success) {
        stored++
        preview.stored = true
      } else {
        failed++
        console.warn(`store failed: ${JSON.stringify(result).slice(0, 200)}`)
      }
    } catch (e) {
      failed++
      console.warn(`store threw: ${e instanceof Error ? e.message : String(e)}`)
    }
    keptPreview.push(preview)
  }

  // The watermark advances over every parsed turn, not just kept ones — a low-scoring
  // turn must never be re-classified (and re-billed) on the next run.
  const maxLine = allUnits.reduce((m, u) => Math.max(m, u.line), wm.lastLine)
  if (!opts.dryRun) saveWatermark(wmPath, { lastLine: maxLine })

  return {
    sessionId,
    project,
    turnsParsed: allUnits.length,
    turnsConsidered: newUnits.length,
    jevCalls: scoreStats.jevCalls,
    sophiaDropped: scoreStats.sophiaDropped,
    kept: kept.length,
    stored,
    dedupSkipped,
    failed,
    totalCostUsd: scoreStats.totalCostUsd,
    totalLatencyMs: scoreStats.totalLatencyMs,
    keptPreview
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv)

  const engine = createJevDecisionEngineFromEnv()
  if (!engine) {
    console.error(
      'jev: no credential route (ONECLI_TOKEN+ONECLI_GATEWAY, or TYPESAFE_API_KEY) — cannot classify transcript turns.'
    )
    process.exit(2)
  }
  const jev = new EngineSessionJevClient(engine)

  const route = routeForCwd(opts.cwd)
  const kmsUrl = opts.kmsUrl || route.kmsUrl

  let kms: MinimalMcpClient | null = null
  if (!opts.dryRun) {
    kms = new MinimalMcpClient(kmsUrl, opts.bearerToken || process.env.KMS_BEARER_TOKEN || null)
    await kms.initialize()
  }

  console.log(`Claude session → KMS review-queue importer`)
  console.log(`  transcript: ${opts.transcript}`)
  console.log(`  cwd:        ${opts.cwd}`)
  console.log(`  kms url:    ${kmsUrl}`)
  console.log(`  dry run:    ${opts.dryRun}`)
  console.log(`  max keep:   ${opts.max}`)
  console.log(`  threshold:  ${opts.threshold}`)
  console.log(`  review:     ${opts.review}`)

  const report = await runSessionImport(opts, { jev, kms })
  if (kms) await kms.close()

  console.log(`\n== REPORT ==`)
  console.log(JSON.stringify(report, null, 2))

  process.exit(report.failed > 0 ? 1 : 0)
}

// No top-level `main()` invocation here, deliberately: this module must stay
// import-only / side-effect-free so its symbols can be unit-tested under ts-jest
// without a top-level `import.meta` reference (the CJS-mode test runner rejects it —
// see src/eval/injectionDataset.ts for the same constraint). The CLI entry point is
// `import-claude-session-cli.ts`, mirroring `import-slack-huddles-cli.ts`.
