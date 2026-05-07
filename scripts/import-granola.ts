#!/usr/bin/env tsx
/**
 * Granola → KMS importer.
 *
 * Turns Granola meetings into KMS entries via the dual-write pattern:
 *   1. ONE whole-meeting "memory" entry per meeting (the distilled summary,
 *      NOT the raw transcript), tagged with metadata.subject="Granola.<title>"
 *      and metadata.source_doc="granola://<id>".
 *   2. N (2–5) "key-claim" entries per meeting (OB1 6-type taxonomy mapped to
 *      KMSmcp contentTypes via mapClaimTypeToContentType). Each claim links
 *      back to the whole-meeting entry with metadata.related_to=[...] and
 *      shares the same source_doc pointer.
 *
 * Both write paths route through `unified_store` so the dedup gate fires
 * naturally — duplicate meetings get caught upstream.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Architecture
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Source A (default):  --input <file>
 *   Read meetings from a pre-dumped JSON file. The file shape is:
 *
 *     [
 *       {
 *         "id":         "granola_id_xyz",
 *         "title":      "Project sync — KMSmcp",
 *         "date":       "2026-04-30T14:00:00Z",   // optional ISO
 *         "transcript": "Speaker A: ...\nSpeaker B: ..."
 *       },
 *       ...
 *     ]
 *
 *   This is the agent-driven flow: a Claude Code session (which has the
 *   Granola MCP connected) calls list_meetings + get_meeting_transcript
 *   for the desired window, dumps to JSON, then runs this script.
 *
 * Source B (placeholder): --source granola-mcp --granola-mcp-url ... --granola-mcp-token ...
 *   Direct claude.ai MCP HTTP fetch. Stub'd; not wired in this PR. The
 *   `GranolaSource` interface keeps the seam open. Wiring the live MCP
 *   requires sorting out the claude.ai bearer + endpoint per session,
 *   which is out of scope for the importer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * KMS auth
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The live KMS at http://localhost:8180/mcp requires OAuth (OAUTH_ENABLED=true).
 * The script supports two paths:
 *   1. KMS_BEARER_TOKEN env var (preferred for one-off runs).
 *   2. Auth0 client_credentials grant via OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET +
 *      OAUTH_TOKEN_ENDPOINT + OAUTH_AUDIENCE (preferred for unattended/cron).
 *      Use `doppler run --project ry-local --config dev_personal -- tsx ...`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Usage
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   # 1. Dump meetings from Granola via your Claude Code session into a JSON file:
 *   #    (have the agent call mcp__claude_ai_Granola__list_meetings + get_meeting_transcript
 *   #     for time_range="last_30_days" and write to ~/granola-dump.json)
 *
 *   # 2. Run the importer (with bearer token):
 *   KMS_BEARER_TOKEN=eyJhbGc...  npx tsx scripts/import-granola.ts --input ~/granola-dump.json
 *
 *   # OR with doppler-managed client_credentials:
 *   doppler run --project ry-local --config dev_personal -- \
 *     npx tsx scripts/import-granola.ts --input ~/granola-dump.json
 *
 *   # Other flags:
 *   #   --time-range last_30_days|this_week|last_week|custom|all_time   (advisory only;
 *   #     the source file is the source of truth; this is logged for traceability)
 *   #   --custom-start YYYY-MM-DD --custom-end YYYY-MM-DD               (with --time-range custom)
 *   #   --kms-url http://localhost:8180/mcp                             (default)
 *   #   --sync-log ~/.kms-granola-sync.json                             (default)
 *   #   --user-id richard_yaker                                         (default — must match KMS_DEFAULT_USER_ID)
 *   #   --anthropic-model claude-haiku-4-5                              (default)
 *   #   --dry-run                                                       (skip the actual KMS writes; log what would happen)
 *   #   --max-meetings <N>                                              (cap, useful for smoke-testing)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Resumability
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `~/.kms-granola-sync.json` is a JSON array of completed Granola meeting IDs.
 * Re-running the script skips meetings already in the log. Failed meetings
 * are NOT added to the log (so they retry next run).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Final report shape
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   {
 *     "totalMeetings":  N,
 *     "summaries":      N,                  // whole-meeting entries created
 *     "claims":         N,                  // key-claim entries created
 *     "skipped":        [{ id, title }],    // already in sync log
 *     "failed":         [{ id, title, reason }],
 *     "dedupRefused":   [{ id, title, candidates }]  // gate refused (counted distinctly from "failed")
 *   }
 */

import Anthropic from '@anthropic-ai/sdk'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  buildDistillPrompt,
  DistilledMeeting,
  mapClaimTypeToContentType,
  parseDistilledResponse
} from '../src/scripts/granola-distill-prompt.js'

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

interface RawMeeting {
  id: string
  title: string
  date?: string
  transcript: string
}

interface SyncLog {
  completed: string[]
  lastRun?: string
}

interface ImportReport {
  totalMeetings: number
  summaries: number
  claims: number
  skipped: Array<{ id: string; title: string }>
  failed: Array<{ id: string; title: string; reason: string }>
  dedupRefused: Array<{ id: string; title: string; candidates: any[] }>
}

interface CliOptions {
  input?: string
  timeRange: string
  customStart?: string
  customEnd?: string
  kmsUrl: string
  syncLogPath: string
  userId: string
  anthropicModel: string
  dryRun: boolean
  maxMeetings?: number
  bearerToken?: string
}

// ─────────────────────────────────────────────────────────────────────────
// Argv parsing — small, no dep on yargs/commander
// ─────────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    timeRange: 'last_30_days',
    kmsUrl: process.env.KMS_URL || 'http://localhost:8180/mcp',
    syncLogPath: process.env.KMS_GRANOLA_SYNC_LOG || join(homedir(), '.kms-granola-sync.json'),
    userId: process.env.KMS_DEFAULT_USER_ID || 'richard_yaker',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    dryRun: false,
    bearerToken: process.env.KMS_BEARER_TOKEN
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--input':              opts.input = next(); break
      case '--time-range':         opts.timeRange = next(); break
      case '--custom-start':       opts.customStart = next(); break
      case '--custom-end':         opts.customEnd = next(); break
      case '--kms-url':            opts.kmsUrl = next(); break
      case '--sync-log':           opts.syncLogPath = next(); break
      case '--user-id':            opts.userId = next(); break
      case '--anthropic-model':    opts.anthropicModel = next(); break
      case '--bearer-token':       opts.bearerToken = next(); break
      case '--dry-run':            opts.dryRun = true; break
      case '--max-meetings':       opts.maxMeetings = parseInt(next(), 10); break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown flag: ${arg}`)
          process.exit(2)
        }
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`
Granola → KMS importer

Usage:
  tsx scripts/import-granola.ts --input <meetings.json> [options]

Required:
  --input <file>            Path to a JSON array of meetings.

Options:
  --time-range <r>          last_30_days (default) | this_week | last_week | custom | all_time (advisory)
  --custom-start YYYY-MM-DD With --time-range custom (advisory)
  --custom-end YYYY-MM-DD   With --time-range custom (advisory)
  --kms-url <url>           default: http://localhost:8180/mcp
  --sync-log <path>         default: ~/.kms-granola-sync.json
  --user-id <id>            default: richard_yaker (or KMS_DEFAULT_USER_ID env)
  --anthropic-model <id>    default: claude-haiku-4-5
  --bearer-token <token>    Bypass OAuth client-credentials, pass token directly.
                            Or set KMS_BEARER_TOKEN env var.
  --dry-run                 Don't actually write to KMS. Log what would happen.
  --max-meetings <N>        Cap meetings processed (smoke-test).
  -h, --help                This help.

Environment:
  KMS_BEARER_TOKEN          Preferred OAuth path for one-off runs.
  ANTHROPIC_API_KEY         Required (Haiku 4.5 distillation).
  KMS_URL                   Override --kms-url.
  KMS_DEFAULT_USER_ID       Default --user-id.

  When KMS_BEARER_TOKEN is unset, the script falls back to Auth0 client_credentials
  using OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_TOKEN_ENDPOINT, OAUTH_AUDIENCE
  (typically supplied by 'doppler run --project ry-local --config dev_personal --').
`)
}

// ─────────────────────────────────────────────────────────────────────────
// Sync log
// ─────────────────────────────────────────────────────────────────────────

export function loadSyncLog(path: string): SyncLog {
  if (!existsSync(path)) {
    return { completed: [] }
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.completed)) {
      console.warn(`⚠️  Sync log at ${path} is malformed; starting empty.`)
      return { completed: [] }
    }
    return { completed: parsed.completed, lastRun: parsed.lastRun }
  } catch (e) {
    console.warn(`⚠️  Could not read sync log ${path}: ${e instanceof Error ? e.message : e}`)
    return { completed: [] }
  }
}

export function saveSyncLog(path: string, log: SyncLog): void {
  writeFileSync(
    path,
    JSON.stringify({ ...log, lastRun: new Date().toISOString() }, null, 2),
    'utf-8'
  )
}

// ─────────────────────────────────────────────────────────────────────────
// OAuth — get bearer token via client_credentials if not supplied
// ─────────────────────────────────────────────────────────────────────────

async function fetchBearerTokenIfNeeded(opts: CliOptions): Promise<string | null> {
  if (opts.bearerToken) return opts.bearerToken

  const tokenEndpoint = process.env.OAUTH_TOKEN_ENDPOINT
  const clientId = process.env.OAUTH_CLIENT_ID
  const clientSecret = process.env.OAUTH_CLIENT_SECRET
  const audience = process.env.OAUTH_AUDIENCE

  if (!tokenEndpoint || !clientId || !clientSecret || !audience) {
    console.warn(
      `⚠️  No --bearer-token / KMS_BEARER_TOKEN set, and OAuth client_credentials env ` +
      `vars are incomplete. Will attempt unauthenticated calls (will fail if KMS has OAUTH_ENABLED=true).`
    )
    return null
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    audience
  })

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`OAuth token request failed (${res.status}): ${txt}`)
  }
  const data = await res.json() as { access_token?: string }
  if (!data.access_token) {
    throw new Error(`OAuth token response had no access_token: ${JSON.stringify(data)}`)
  }
  return data.access_token
}

// ─────────────────────────────────────────────────────────────────────────
// MCP client — minimal StreamableHTTP-compatible wrapper
// ─────────────────────────────────────────────────────────────────────────

export class MinimalMcpClient {
  private kmsUrl: string
  private bearer: string | null
  private sessionId: string | null = null
  private nextId = 1

  constructor(kmsUrl: string, bearer: string | null) {
    this.kmsUrl = kmsUrl
    this.bearer = bearer
  }

  async initialize(): Promise<void> {
    const initBody = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'granola-importer', version: '1.0.0' }
      },
      id: this.nextId++
    }
    const { sessionId, body } = await this.postRaw(initBody, /* expectSession */ true)
    if (!sessionId) {
      throw new Error(
        `MCP initialize did not return mcp-session-id header. Body: ${JSON.stringify(body).slice(0, 500)}`
      )
    }
    this.sessionId = sessionId

    // Send the required initialized notification.
    await this.postRaw(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      false
    )
  }

  /**
   * Call a tool. Returns the parsed JSON result that the tool returned
   * (i.e. the inner JSON payload from `result.content[0].text`).
   */
  async callTool<T = any>(name: string, args: Record<string, any>): Promise<T> {
    if (!this.sessionId) throw new Error('MCP client not initialized')
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id: this.nextId++
    }
    const { body: response } = await this.postRaw(body, false)
    if (response.error) {
      throw new Error(
        `Tool ${name} failed: ${response.error.message} (code ${response.error.code})`
      )
    }
    const text = response?.result?.content?.[0]?.text
    if (typeof text !== 'string') {
      throw new Error(
        `Tool ${name} returned unexpected shape (no result.content[0].text): ${JSON.stringify(response).slice(0, 400)}`
      )
    }
    try {
      return JSON.parse(text) as T
    } catch (e) {
      throw new Error(
        `Tool ${name} returned non-JSON text body: ${text.slice(0, 400)}`
      )
    }
  }

  private async postRaw(
    body: any,
    captureSession: boolean
  ): Promise<{ sessionId: string | null; body: any }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Both MUST be in Accept; the StreamableHTTP SDK requires it.
      'Accept': 'application/json, text/event-stream'
    }
    if (this.bearer) headers['Authorization'] = `Bearer ${this.bearer}`
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId

    const res = await fetch(this.kmsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })

    const sessionHeader = res.headers.get('mcp-session-id')
    const text = await res.text()

    // Notifications get 202 with empty body — that's normal.
    if (res.status === 202 && (!text || text.trim().length === 0)) {
      return { sessionId: captureSession ? sessionHeader : null, body: null }
    }

    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`)
    }

    // Try direct JSON first; fall back to SSE-line parse for clients that
    // negotiated text/event-stream (the KMS sends one or the other depending
    // on Accept handling).
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = parseSseToJson(text)
    }
    return { sessionId: captureSession ? sessionHeader : null, body: parsed }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return
    try {
      const headers: Record<string, string> = { 'mcp-session-id': this.sessionId }
      if (this.bearer) headers['Authorization'] = `Bearer ${this.bearer}`
      await fetch(this.kmsUrl, { method: 'DELETE', headers })
    } catch {
      // best-effort
    }
  }
}

function parseSseToJson(sse: string): any {
  // Find last `data: ...` line (StreamableHTTP single-message responses
  // emit a single data chunk per JSON-RPC reply).
  const lines = sse.split(/\r?\n/)
  const dataLines = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6))
  if (dataLines.length === 0) {
    throw new Error(`Could not parse MCP response (not JSON, not SSE): ${sse.slice(0, 200)}`)
  }
  // Concatenate (some chunks span lines)
  const joined = dataLines.join('')
  return JSON.parse(joined)
}

// ─────────────────────────────────────────────────────────────────────────
// Granola source — read meetings from a JSON dump file
// ─────────────────────────────────────────────────────────────────────────

export interface GranolaSource {
  list(): Promise<RawMeeting[]>
}

export class FileGranolaSource implements GranolaSource {
  constructor(private path: string) {}

  async list(): Promise<RawMeeting[]> {
    if (!existsSync(this.path)) {
      throw new Error(`Granola dump file not found: ${this.path}`)
    }
    const raw = readFileSync(this.path, 'utf-8')
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error(`Granola dump is not valid JSON: ${e instanceof Error ? e.message : e}`)
    }
    if (!Array.isArray(parsed)) {
      throw new Error('Granola dump must be a top-level JSON array of meetings')
    }
    return parsed.map((m: any, i: number): RawMeeting => {
      if (!m || typeof m !== 'object') {
        throw new Error(`Meeting ${i} is not an object`)
      }
      if (typeof m.id !== 'string' || typeof m.title !== 'string' || typeof m.transcript !== 'string') {
        throw new Error(
          `Meeting ${i} missing required string fields (id, title, transcript): ${JSON.stringify(m).slice(0, 200)}`
        )
      }
      return {
        id: m.id,
        title: m.title,
        date: typeof m.date === 'string' ? m.date : undefined,
        transcript: m.transcript
      }
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Distillation — Haiku 4.5 via @anthropic-ai/sdk
// ─────────────────────────────────────────────────────────────────────────

export interface DistillerLike {
  distill(meeting: RawMeeting): Promise<DistilledMeeting>
}

export class HaikuDistiller implements DistillerLike {
  private client: Anthropic
  private model: string

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async distill(meeting: RawMeeting): Promise<DistilledMeeting> {
    const { system, user } = buildDistillPrompt({
      title: meeting.title,
      meetingId: meeting.id,
      date: meeting.date,
      transcript: meeting.transcript
    })

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }]
    })

    // resp.content[0] is a text block when Haiku follows the prompt.
    const block = resp.content?.[0] as any
    const text = block?.type === 'text' ? block.text : ''
    return parseDistilledResponse(text)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Importer driver
// ─────────────────────────────────────────────────────────────────────────

interface ImporterDeps {
  source: GranolaSource
  distiller: DistillerLike
  kms: MinimalMcpClient | null  // null in --dry-run
  opts: CliOptions
  log: SyncLog
}

interface SingleMeetingResult {
  status: 'ok' | 'skipped' | 'failed' | 'dedup_refused'
  meeting: RawMeeting
  reason?: string
  candidates?: any[]
  summaryEntryId?: string
  claimEntryIds?: string[]
}

/**
 * Process a single meeting end-to-end.
 *
 * Public so tests can target one meeting at a time.
 */
export async function processMeeting(
  meeting: RawMeeting,
  deps: ImporterDeps
): Promise<SingleMeetingResult> {
  if (deps.log.completed.includes(meeting.id)) {
    return { status: 'skipped', meeting, reason: 'already in sync log' }
  }

  // Distill
  let distilled: DistilledMeeting
  try {
    distilled = await deps.distiller.distill(meeting)
  } catch (e) {
    return {
      status: 'failed',
      meeting,
      reason: `distill: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (deps.opts.dryRun) {
    console.log(`📝 [dry-run] would write summary + ${distilled.claims.length} claims for "${meeting.title}"`)
    return {
      status: 'ok',
      meeting,
      summaryEntryId: 'dry-run-summary',
      claimEntryIds: distilled.claims.map((_, i) => `dry-run-claim-${i}`)
    }
  }

  if (!deps.kms) {
    return { status: 'failed', meeting, reason: 'no KMS client and not dry-run (internal error)' }
  }

  // Step 1: write whole-meeting summary entry
  const subject = `Granola.${meeting.title}`
  const sourceDoc = `granola://${meeting.id}`
  const summaryArgs = {
    content: distilled.summary,
    contentType: 'memory' as const,
    source: 'personal' as const,
    userId: deps.opts.userId,
    metadata: {
      subject,
      source: 'granola',
      granola_meeting_id: meeting.id,
      meeting_date: meeting.date,
      source_doc: sourceDoc,
      meeting_title: meeting.title
    }
  }

  let summaryResult: any
  try {
    summaryResult = await deps.kms.callTool('unified_store', summaryArgs)
  } catch (e) {
    return {
      status: 'failed',
      meeting,
      reason: `summary write: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // Dedup gate refusal — skip cleanly, log, don't fail the whole run.
  if (summaryResult?.status === 'dedup_required') {
    return {
      status: 'dedup_refused',
      meeting,
      candidates: summaryResult.candidates ?? [],
      reason: summaryResult.message ?? 'dedup_required'
    }
  }
  if (!summaryResult?.success || typeof summaryResult.id !== 'string') {
    return {
      status: 'failed',
      meeting,
      reason: `summary write returned unexpected shape: ${JSON.stringify(summaryResult).slice(0, 300)}`
    }
  }

  const summaryEntryId = summaryResult.id as string

  // Step 2: write each claim with metadata.related_to=[summaryEntryId]
  const claimEntryIds: string[] = []
  const claimFailures: string[] = []
  for (let ci = 0; ci < distilled.claims.length; ci++) {
    const claim = distilled.claims[ci]
    const claimArgs = {
      content: claim.content,
      contentType: mapClaimTypeToContentType(claim.type),
      source: 'personal' as const,
      userId: deps.opts.userId,
      metadata: {
        subject: `${subject}.claim_${ci}`,
        source: 'granola',
        source_doc: sourceDoc,
        granola_meeting_id: meeting.id,
        meeting_date: meeting.date,
        ob1_type: claim.type,
        ob1_confidence: claim.confidence,
        topics: claim.topics,
        people: claim.people,
        related_to: [summaryEntryId]
      }
    }

    try {
      const claimResult: any = await deps.kms.callTool('unified_store', claimArgs)
      if (claimResult?.status === 'dedup_required') {
        // Dedup refusal on a claim is non-fatal — log and move on.
        claimFailures.push(
          `claim ${ci} (${claim.type}): dedup_refused against ${claimResult.candidates?.[0]?.id ?? '?'}`
        )
        continue
      }
      if (!claimResult?.success || typeof claimResult.id !== 'string') {
        claimFailures.push(`claim ${ci} (${claim.type}): unexpected response`)
        continue
      }
      claimEntryIds.push(claimResult.id)
    } catch (e) {
      claimFailures.push(
        `claim ${ci} (${claim.type}): ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  // Even with some claim failures, we count the meeting OK if the summary
  // landed — the summary IS the meeting record. Claims are bonus enrichment.
  if (claimFailures.length > 0) {
    console.warn(
      `⚠️  Meeting "${meeting.title}" had ${claimFailures.length}/${distilled.claims.length} claim failure(s):\n  ${claimFailures.join('\n  ')}`
    )
  }

  return {
    status: 'ok',
    meeting,
    summaryEntryId,
    claimEntryIds
  }
}

export async function runImport(deps: ImporterDeps): Promise<ImportReport> {
  const meetingsAll = await deps.source.list()
  const meetings = deps.opts.maxMeetings
    ? meetingsAll.slice(0, deps.opts.maxMeetings)
    : meetingsAll

  console.log(
    `📥 Loaded ${meetings.length} meeting(s) from source ` +
    `(time-range advisory: ${deps.opts.timeRange}${
      deps.opts.timeRange === 'custom'
        ? ` ${deps.opts.customStart ?? '?'}..${deps.opts.customEnd ?? '?'}`
        : ''
    })`
  )

  const report: ImportReport = {
    totalMeetings: meetings.length,
    summaries: 0,
    claims: 0,
    skipped: [],
    failed: [],
    dedupRefused: []
  }

  const t0 = Date.now()
  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i]
    const result = await processMeeting(meeting, deps)

    switch (result.status) {
      case 'ok':
        report.summaries += 1
        report.claims += result.claimEntryIds?.length ?? 0
        deps.log.completed.push(meeting.id)
        // Save sync log immediately after each success — partial progress is
        // valuable, especially for long Haiku-bound runs.
        if (!deps.opts.dryRun) saveSyncLog(deps.opts.syncLogPath, deps.log)
        break
      case 'skipped':
        report.skipped.push({ id: meeting.id, title: meeting.title })
        break
      case 'failed':
        report.failed.push({ id: meeting.id, title: meeting.title, reason: result.reason ?? 'unknown' })
        console.error(`❌ Meeting "${meeting.title}" (${meeting.id}) failed: ${result.reason}`)
        break
      case 'dedup_refused':
        report.dedupRefused.push({
          id: meeting.id,
          title: meeting.title,
          candidates: result.candidates ?? []
        })
        console.warn(
          `🛑 Meeting "${meeting.title}" (${meeting.id}) refused by dedup gate ` +
          `against ${result.candidates?.[0]?.id ?? '?'}`
        )
        break
    }

    if ((i + 1) % 5 === 0 || i === meetings.length - 1) {
      const elapsedMs = Date.now() - t0
      const perMeeting = elapsedMs / (i + 1)
      const remaining = meetings.length - (i + 1)
      const etaMin = Math.round((perMeeting * remaining) / 60000)
      console.log(
        `⏱️  ${i + 1}/${meetings.length} done, ETA ${etaMin}min, last_meeting="${meeting.title}"`
      )
    }
  }

  return report
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  if (!opts.input) {
    console.error('❌ --input <file> is required (path to a JSON array of meetings).')
    console.error('   See --help for the expected file shape.')
    process.exit(2)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey && !opts.dryRun) {
    console.error('❌ ANTHROPIC_API_KEY env var is required (Haiku 4.5 distillation).')
    console.error('   Set it directly or via doppler. Use --dry-run to skip distillation.')
    process.exit(2)
  }

  console.log(`🚀 Granola → KMS importer starting`)
  console.log(`   Input:        ${opts.input}`)
  console.log(`   KMS URL:      ${opts.kmsUrl}`)
  console.log(`   Sync log:     ${opts.syncLogPath}`)
  console.log(`   User ID:      ${opts.userId}`)
  console.log(`   Model:        ${opts.anthropicModel}`)
  console.log(`   Dry run:      ${opts.dryRun}`)
  if (opts.maxMeetings) console.log(`   Cap:          ${opts.maxMeetings} meetings`)

  const source = new FileGranolaSource(opts.input)
  const distiller = opts.dryRun
    ? new NoopDistiller()
    : new HaikuDistiller(apiKey!, opts.anthropicModel)

  let kms: MinimalMcpClient | null = null
  if (!opts.dryRun) {
    const bearer = await fetchBearerTokenIfNeeded(opts).catch(e => {
      console.error(`❌ Could not obtain KMS bearer token: ${e instanceof Error ? e.message : e}`)
      process.exit(2)
    })
    kms = new MinimalMcpClient(opts.kmsUrl, bearer ?? null)
    await kms.initialize()
    console.log(`🔌 Connected to KMS, session active.`)
  }

  const log = loadSyncLog(opts.syncLogPath)
  console.log(`📓 Sync log has ${log.completed.length} previously-completed meeting(s).`)

  const report = await runImport({ source, distiller, kms, opts, log })

  if (kms) await kms.close()

  console.log(`\n══════════════ FINAL REPORT ══════════════`)
  console.log(`Total meetings:       ${report.totalMeetings}`)
  console.log(`Summary entries:      ${report.summaries}`)
  console.log(`Claim entries:        ${report.claims}`)
  console.log(`Skipped (sync log):   ${report.skipped.length}`)
  console.log(`Dedup refused:        ${report.dedupRefused.length}`)
  console.log(`Failed:               ${report.failed.length}`)
  if (report.failed.length > 0) {
    console.log(`\nFailures:`)
    for (const f of report.failed) {
      console.log(`  - "${f.title}" (${f.id}): ${f.reason}`)
    }
  }
  if (report.dedupRefused.length > 0) {
    console.log(`\nDedup refused (already in KMS):`)
    for (const d of report.dedupRefused) {
      console.log(`  - "${d.title}" (${d.id}) → top candidate ${d.candidates[0]?.id ?? '?'}`)
    }
  }
  console.log(`\n✅ Done.`)

  // Non-zero exit if any meeting hard-failed (dedup refusal is informational)
  process.exit(report.failed.length > 0 ? 1 : 0)
}

/** Distiller that returns a stable stub — used in --dry-run when we still want to walk the pipeline. */
class NoopDistiller implements DistillerLike {
  async distill(meeting: RawMeeting): Promise<DistilledMeeting> {
    return {
      summary: `[dry-run stub] meeting ${meeting.id} (${meeting.title}) — would distill ${meeting.transcript.length} chars`,
      claims: [
        {
          type: 'context',
          content: `[dry-run stub] context placeholder for meeting ${meeting.title}`,
          confidence: 'tentative',
          topics: ['dry-run'],
          people: []
        }
      ]
    }
  }
}

// Only run main() when invoked as a CLI, not when imported by tests.
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('import-granola.ts') || process.argv[1].endsWith('import-granola.js'))

if (isMainModule) {
  main().catch(e => {
    console.error(`💥 Unhandled: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    process.exit(1)
  })
}
