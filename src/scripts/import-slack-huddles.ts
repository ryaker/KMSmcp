/**
 * Slack Huddle → KMS importer.
 *
 * Turns Slack huddle AI-notes (the canvas posted by Slackbot after a huddle
 * ends) into KMS entries via the dual-write pattern, mirroring PR #74's
 * Granola importer:
 *   1. ONE whole-huddle "memory" entry per huddle (the distilled summary,
 *      NOT the raw canvas markdown), tagged with metadata.subject="Slack.huddle.<channel>.<date>"
 *      and metadata.source_doc="slack://canvas/<team_id>/<file_id>".
 *   2. N (2–5) typed claim entries per huddle (OB1 6-type taxonomy mapped to
 *      KMSmcp contentTypes via mapClaimTypeToContentType). Each claim links
 *      back to the whole-huddle entry with metadata.related_to=[...] and
 *      shares the same source_doc pointer.
 *
 * Both write paths route through `unified_store` so the dedup gate fires
 * naturally — overlap with Granola transcripts of the same huddle gets
 * caught upstream (action=complement or duplicate).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Architecture — Source abstraction (mirrors PR #74's GranolaSource)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Source A — `LiveSlackSource`:
 *   Calls slack_search_public + slack_read_canvas via the connected Slack MCP
 *   at runtime. This is the production path; works when run from a Claude
 *   Code session that has Slack MCP authorized. For unattended/cron runs,
 *   the Slack MCP isn't reachable, so use Source B.
 *
 *   Wired via dependency injection of two callbacks:
 *     - searchPublic(query, opts) → { messages: [...] }
 *     - readCanvas(canvasId)      → { canvas_markdown: "..." }
 *
 *   The driver agent (Claude Code) supplies these callbacks at construction
 *   time, so the importer module itself stays free of MCP-runtime imports.
 *
 * Source B — `FileSlackSource`:
 *   Reads from a pre-dumped JSON file (cron/launchd contexts). The file
 *   shape matches what LiveSlackSource produces:
 *
 *     [
 *       {
 *         "channel_id":   "C0123ABCD",
 *         "channel_name": "core-values",
 *         "message_ts":   "1714098000.000400",
 *         "team_id":      "T0123ABCD",
 *         "file_id":      "F4567WXYZ",
 *         "huddle_date":  "2026-04-11T16:00:00Z",     // optional ISO; falls back to ts
 *         "canvas_markdown": "..."
 *       },
 *       ...
 *     ]
 *
 *   This is the agent-driven flow: a Claude Code session (which has the
 *   Slack MCP connected) does the discovery + canvas fetch, dumps to JSON,
 *   then the cron job runs this script.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * KMS auth
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The live KMS at http://localhost:8180/mcp requires OAuth (OAUTH_ENABLED=true).
 * Two paths supported:
 *   1. KMS_BEARER_TOKEN env var (preferred for one-off runs).
 *   2. Auth0 client_credentials grant via OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET +
 *      OAUTH_TOKEN_ENDPOINT + OAUTH_AUDIENCE (preferred for unattended/cron).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Resumability
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `~/.kms-slack-huddle-sync.json` is keyed by canvas_file_id. Re-running the
 * script skips canvases already in the log. Failed canvases are NOT added to
 * the log (so they retry on next run).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Final report shape
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   {
 *     "totalHuddles":  N,
 *     "summaries":     N,                   // whole-huddle entries created
 *     "claims":        N,                   // claim entries created
 *     "skipped":       [{ fileId, channel }],   // already in sync log
 *     "failed":        [{ fileId, channel, reason }],
 *     "dedupRefused":  [{ fileId, channel, candidates }]
 *   }
 */

import Anthropic from '@anthropic-ai/sdk'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  buildDistillPrompt,
  DistilledHuddle,
  extractCanvasId,
  isSlackbotHuddleRecap,
  mapClaimTypeToContentType,
  parseDistilledResponse
} from './slack-huddle-distill-prompt.js'

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

/** Normalized representation of one huddle, ready to distill + import. */
export interface RawHuddle {
  channelId: string
  channelName: string
  messageTs: string
  teamId: string
  fileId: string
  /** ISO date of the huddle. Optional — falls back to messageTs converted from epoch. */
  huddleDate?: string
  /** The canvas markdown body (NOT the recap message text). */
  canvasMarkdown: string
}

export interface SyncLog {
  /** Array of canvas file_ids that have been successfully imported. */
  completed: string[]
  lastRun?: string
}

export interface ImportReport {
  totalHuddles: number
  summaries: number
  claims: number
  skipped: Array<{ fileId: string; channel: string }>
  failed: Array<{ fileId: string; channel: string; reason: string }>
  dedupRefused: Array<{ fileId: string; channel: string; candidates: any[] }>
}

export interface CliOptions {
  input?: string
  source: 'file' | 'live'
  /** Slack search query; defaults to the canonical Slackbot recap probe. */
  searchQuery: string
  searchLimit: number
  kmsUrl: string
  syncLogPath: string
  userId: string
  anthropicModel: string
  workspace: string
  dryRun: boolean
  maxHuddles?: number
  bearerToken?: string
}

// ─────────────────────────────────────────────────────────────────────────
// Argv parsing
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_SEARCH_QUERY =
  '"AI huddle notes are ready" from:USLACKBOT'

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    source: 'file',
    searchQuery: DEFAULT_SEARCH_QUERY,
    searchLimit: 20,
    kmsUrl: process.env.KMS_URL || 'http://localhost:8180/mcp',
    syncLogPath:
      process.env.KMS_SLACK_HUDDLE_SYNC_LOG ||
      join(homedir(), '.kms-slack-huddle-sync.json'),
    userId: process.env.KMS_DEFAULT_USER_ID || 'richard_yaker',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    workspace: process.env.SLACK_WORKSPACE || 'tengo',
    dryRun: false,
    bearerToken: process.env.KMS_BEARER_TOKEN
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--input':           opts.input = next(); break
      case '--source':          opts.source = next() as 'file' | 'live'; break
      case '--search-query':    opts.searchQuery = next(); break
      case '--search-limit':    opts.searchLimit = parseInt(next(), 10); break
      case '--kms-url':         opts.kmsUrl = next(); break
      case '--sync-log':        opts.syncLogPath = next(); break
      case '--user-id':         opts.userId = next(); break
      case '--anthropic-model': opts.anthropicModel = next(); break
      case '--workspace':       opts.workspace = next(); break
      case '--bearer-token':    opts.bearerToken = next(); break
      case '--dry-run':         opts.dryRun = true; break
      case '--max-huddles':     opts.maxHuddles = parseInt(next(), 10); break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`)
        }
    }
  }
  if (opts.source !== 'file' && opts.source !== 'live') {
    throw new Error(`Invalid --source: ${opts.source} (expected 'file' or 'live')`)
  }
  return opts
}

function printHelp(): void {
  console.log(`
Slack Huddle → KMS importer

Usage:
  node dist/scripts/import-slack-huddles-cli.js [options]

Modes:
  --source file --input <path>   Read pre-dumped huddle JSON from a file (default).
  --source live                  Use LiveSlackSource (requires the script to be
                                 run from a Claude Code session whose driver
                                 wires slack_search_public + slack_read_canvas
                                 into the importer).

Options:
  --input <file>             Path to a JSON array of huddles (--source file).
  --search-query <q>         Override the Slack search query (--source live).
                             Default: "AI huddle notes are ready" from:USLACKBOT
  --search-limit <n>         Max search results (default 20).
  --workspace <slug>         Slack workspace label written into metadata
                             (default 'tengo').
  --kms-url <url>            default: http://localhost:8180/mcp
  --sync-log <path>          default: ~/.kms-slack-huddle-sync.json
  --user-id <id>             default: richard_yaker (or KMS_DEFAULT_USER_ID env)
  --anthropic-model <id>     default: claude-haiku-4-5-20251001
  --bearer-token <token>     Bypass OAuth client-credentials, pass token directly.
                             Or set KMS_BEARER_TOKEN env var.
  --dry-run                  Don't actually write to KMS. Log what would happen.
  --max-huddles <N>          Cap huddles processed (smoke-test).
  -h, --help                 This help.

Environment:
  KMS_BEARER_TOKEN           Preferred OAuth path for one-off runs.
  ANTHROPIC_API_KEY          Required (Haiku 4.5 distillation).
  KMS_URL                    Override --kms-url.
  KMS_DEFAULT_USER_ID        Default --user-id.
  SLACK_WORKSPACE            Default --workspace label.

  When KMS_BEARER_TOKEN is unset, the script falls back to Auth0 client_credentials
  using OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_TOKEN_ENDPOINT, OAUTH_AUDIENCE.
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
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) {
    throw new Error(`OAuth token response had no access_token: ${JSON.stringify(data)}`)
  }
  return data.access_token
}

// ─────────────────────────────────────────────────────────────────────────
// MCP client — minimal StreamableHTTP-compatible wrapper (mirrors PR #74)
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
        clientInfo: { name: 'slack-huddle-importer', version: '1.0.0' }
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

  async callTool<T = any>(name: string, args: Record<string, any>): Promise<T> {
    if (!this.sessionId) throw new Error('MCP client not initialized')
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id: this.nextId++
    }
    const { body: response } = await this.postRaw(body, false)
    if (response?.error) {
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
    } catch {
      throw new Error(`Tool ${name} returned non-JSON text body: ${text.slice(0, 400)}`)
    }
  }

  private async postRaw(
    body: any,
    captureSession: boolean
  ): Promise<{ sessionId: string | null; body: any }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
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
  const lines = sse.split(/\r?\n/)
  const dataLines = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6))
  if (dataLines.length === 0) {
    throw new Error(`Could not parse MCP response (not JSON, not SSE): ${sse.slice(0, 200)}`)
  }
  const joined = dataLines.join('')
  return JSON.parse(joined)
}

// ─────────────────────────────────────────────────────────────────────────
// Slack source abstraction
// ─────────────────────────────────────────────────────────────────────────

/**
 * A Slack search-result message. This is the subset of fields the importer
 * actually reads — both the live MCP shape and the file-dump shape can map to it.
 */
export interface SlackSearchMessage {
  user?: string
  username?: string
  text?: string
  ts?: string
  /** Channel info; varies by Slack API surface. */
  channel?: { id?: string; name?: string } | string
  channel_id?: string
  channel_name?: string
}

export interface SlackHuddleSource {
  list(): Promise<RawHuddle[]>
}

/**
 * FileSlackSource — reads pre-dumped huddles from a JSON file.
 *
 * Two file shapes accepted:
 *   A. "Pre-resolved" shape — array of RawHuddle-like objects with
 *      canvas_markdown already pre-fetched. This is the cron path.
 *   B. "Search-results + canvases" shape:
 *        {
 *          "messages": [<SlackSearchMessage>, ...],
 *          "canvases": { "<file_id>": "<markdown>", ... }
 *        }
 *      The importer extracts canvas IDs from messages and joins to canvases.
 */
export class FileSlackSource implements SlackHuddleSource {
  constructor(private path: string) {}

  async list(): Promise<RawHuddle[]> {
    if (!existsSync(this.path)) {
      throw new Error(`Slack huddle dump file not found: ${this.path}`)
    }
    const raw = readFileSync(this.path, 'utf-8')
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error(
        `Slack huddle dump is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
      )
    }

    if (Array.isArray(parsed)) {
      return parsed.map((m, i) => normalizePreResolvedHuddle(m, i))
    }

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
      const canvases: Record<string, string> = parsed.canvases ?? {}
      const out: RawHuddle[] = []
      for (const msg of parsed.messages) {
        if (!isSlackbotHuddleRecap(msg)) continue
        const ids = extractCanvasId(msg.text ?? '')
        if (!ids) continue
        const canvasMd = canvases[ids.fileId]
        if (typeof canvasMd !== 'string') {
          console.warn(`⚠️  No canvas markdown for ${ids.fileId} in dump; skipping.`)
          continue
        }
        const channel = readChannel(msg)
        out.push({
          channelId: channel.id,
          channelName: channel.name,
          messageTs: typeof msg.ts === 'string' ? msg.ts : '',
          teamId: ids.teamId,
          fileId: ids.fileId,
          huddleDate: tsToIsoDate(msg.ts),
          canvasMarkdown: canvasMd
        })
      }
      return out
    }

    throw new Error(
      'Slack huddle dump must be either a top-level array of huddles or an object with `messages` + `canvases` keys'
    )
  }
}

function normalizePreResolvedHuddle(m: any, i: number): RawHuddle {
  if (!m || typeof m !== 'object') {
    throw new Error(`Huddle ${i} is not an object`)
  }
  const required = ['channel_id', 'channel_name', 'message_ts', 'team_id', 'file_id', 'canvas_markdown']
  for (const f of required) {
    if (typeof m[f] !== 'string' || m[f].length === 0) {
      throw new Error(
        `Huddle ${i} missing required string field "${f}": ${JSON.stringify(m).slice(0, 200)}`
      )
    }
  }
  return {
    channelId: m.channel_id,
    channelName: m.channel_name,
    messageTs: m.message_ts,
    teamId: m.team_id,
    fileId: m.file_id,
    huddleDate: typeof m.huddle_date === 'string' ? m.huddle_date : tsToIsoDate(m.message_ts),
    canvasMarkdown: m.canvas_markdown
  }
}

function readChannel(msg: SlackSearchMessage): { id: string; name: string } {
  if (msg && typeof msg.channel === 'object' && msg.channel) {
    return {
      id: typeof msg.channel.id === 'string' ? msg.channel.id : '',
      name: typeof msg.channel.name === 'string' ? msg.channel.name : ''
    }
  }
  return {
    id: msg.channel_id ?? (typeof msg.channel === 'string' ? msg.channel : ''),
    name: msg.channel_name ?? ''
  }
}

function tsToIsoDate(ts: any): string | undefined {
  if (typeof ts !== 'string' && typeof ts !== 'number') return undefined
  const num = typeof ts === 'string' ? parseFloat(ts) : ts
  if (!isFinite(num) || num <= 0) return undefined
  // Slack ts is epoch seconds with sub-second precision; new Date() takes ms.
  return new Date(num * 1000).toISOString()
}

/**
 * LiveSlackSource — uses caller-supplied callbacks that wrap the Slack MCP
 * tools. The callbacks let us avoid importing any MCP-runtime modules into
 * this script (which would only be reachable from a Claude Code session
 * anyway).
 */
export class LiveSlackSource implements SlackHuddleSource {
  constructor(
    private deps: {
      searchPublic: (
        query: string,
        opts: { limit: number; sort?: string }
      ) => Promise<{ messages: SlackSearchMessage[] }>
      readCanvas: (
        canvasId: string
      ) => Promise<{ canvas_markdown: string } | string>
    },
    private opts: { searchQuery: string; searchLimit: number }
  ) {}

  async list(): Promise<RawHuddle[]> {
    const { messages } = await this.deps.searchPublic(this.opts.searchQuery, {
      limit: this.opts.searchLimit,
      sort: 'timestamp'
    })
    if (!Array.isArray(messages)) {
      throw new Error('LiveSlackSource: searchPublic returned no messages array')
    }

    const out: RawHuddle[] = []
    for (const msg of messages) {
      if (!isSlackbotHuddleRecap(msg)) continue
      const ids = extractCanvasId(msg.text ?? '')
      if (!ids) continue

      let canvasMd: string
      try {
        const canvas = await this.deps.readCanvas(ids.fileId)
        if (typeof canvas === 'string') {
          canvasMd = canvas
        } else if (canvas && typeof canvas.canvas_markdown === 'string') {
          canvasMd = canvas.canvas_markdown
        } else {
          console.warn(
            `⚠️  Canvas ${ids.fileId} returned unexpected shape from Slack MCP — skipping.`
          )
          continue
        }
      } catch (e) {
        // Failed canvas fetch is non-fatal — log and skip THIS huddle.
        console.warn(
          `⚠️  Failed to read canvas ${ids.fileId}: ${e instanceof Error ? e.message : String(e)} — skipping.`
        )
        continue
      }

      const channel = readChannel(msg)
      out.push({
        channelId: channel.id,
        channelName: channel.name,
        messageTs: typeof msg.ts === 'string' ? msg.ts : '',
        teamId: ids.teamId,
        fileId: ids.fileId,
        huddleDate: tsToIsoDate(msg.ts),
        canvasMarkdown: canvasMd
      })
    }
    return out
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Distillation — Haiku 4.5 via @anthropic-ai/sdk
// ─────────────────────────────────────────────────────────────────────────

export interface DistillerLike {
  distill(huddle: RawHuddle, workspace: string): Promise<DistilledHuddle>
}

export class HaikuDistiller implements DistillerLike {
  private client: Anthropic
  private model: string

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async distill(huddle: RawHuddle, workspace: string): Promise<DistilledHuddle> {
    const { system, user } = buildDistillPrompt({
      channelName: huddle.channelName,
      huddleDate: huddle.huddleDate,
      canvasMarkdown: huddle.canvasMarkdown,
      workspace
    })

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }]
    })

    const block = resp.content?.[0] as any
    const text = block?.type === 'text' ? block.text : ''
    return parseDistilledResponse(text)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Subject + slug helpers
// ─────────────────────────────────────────────────────────────────────────

/** Slug: lowercased channel name, alnum + dashes only. */
export function slugifyChannel(channelName: string): string {
  return (channelName || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown'
}

/** "Slack.huddle.<channel-slug>.<YYYY-MM-DD>" — the subject facet for a huddle. */
export function buildHuddleSubject(huddle: RawHuddle): string {
  const channelSlug = slugifyChannel(huddle.channelName)
  const date = huddle.huddleDate ? huddle.huddleDate.slice(0, 10) : 'unknown-date'
  return `Slack.huddle.${channelSlug}.${date}`
}

/** "slack://canvas/<team_id>/<file_id>" — canonical source-doc URI. */
export function buildSourceDoc(huddle: RawHuddle): string {
  return `slack://canvas/${huddle.teamId}/${huddle.fileId}`
}

// ─────────────────────────────────────────────────────────────────────────
// Importer driver
// ─────────────────────────────────────────────────────────────────────────

interface ImporterDeps {
  source: SlackHuddleSource
  distiller: DistillerLike
  /** null in --dry-run only. */
  kms: MinimalMcpClient | null
  opts: CliOptions
  log: SyncLog
}

interface SingleHuddleResult {
  status: 'ok' | 'skipped' | 'failed' | 'dedup_refused'
  huddle: RawHuddle
  reason?: string
  candidates?: any[]
  summaryEntryId?: string
  claimEntryIds?: string[]
}

/**
 * Process a single huddle end-to-end. Public so tests can target one at a time.
 */
export async function processHuddle(
  huddle: RawHuddle,
  deps: ImporterDeps
): Promise<SingleHuddleResult> {
  if (deps.log.completed.includes(huddle.fileId)) {
    return { status: 'skipped', huddle, reason: 'already in sync log' }
  }

  // Distill
  let distilled: DistilledHuddle
  try {
    distilled = await deps.distiller.distill(huddle, deps.opts.workspace)
  } catch (e) {
    return {
      status: 'failed',
      huddle,
      reason: `distill: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (deps.opts.dryRun) {
    console.log(
      `📝 [dry-run] would write summary + ${distilled.claims.length} claims for ` +
        `huddle in #${huddle.channelName} (${huddle.fileId})`
    )
    return {
      status: 'ok',
      huddle,
      summaryEntryId: 'dry-run-summary',
      claimEntryIds: distilled.claims.map((_, i) => `dry-run-claim-${i}`)
    }
  }

  if (!deps.kms) {
    return { status: 'failed', huddle, reason: 'no KMS client and not dry-run (internal error)' }
  }

  // Step 1: write whole-huddle summary entry
  const subject = buildHuddleSubject(huddle)
  const sourceDoc = buildSourceDoc(huddle)
  const summaryArgs = {
    content: distilled.summary,
    contentType: 'memory' as const,
    source: 'personal' as const,
    userId: deps.opts.userId,
    metadata: {
      subject,
      source: 'slack_huddle',
      source_doc: sourceDoc,
      slack_workspace: deps.opts.workspace,
      slack_channel: huddle.channelId,
      slack_channel_name: huddle.channelName,
      slack_message_ts: huddle.messageTs,
      slack_team_id: huddle.teamId,
      slack_canvas_id: huddle.fileId,
      huddle_date: huddle.huddleDate
    }
  }

  let summaryResult: any
  try {
    summaryResult = await deps.kms.callTool('unified_store', summaryArgs)
  } catch (e) {
    return {
      status: 'failed',
      huddle,
      reason: `summary write: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // Dedup-gate refusal — non-fatal; log and skip claims for this huddle.
  if (summaryResult?.status === 'dedup_required') {
    return {
      status: 'dedup_refused',
      huddle,
      candidates: summaryResult.candidates ?? [],
      reason: summaryResult.message ?? 'dedup_required'
    }
  }
  if (!summaryResult?.success || typeof summaryResult.id !== 'string') {
    return {
      status: 'failed',
      huddle,
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
        source: 'slack_huddle',
        source_doc: sourceDoc,
        slack_workspace: deps.opts.workspace,
        slack_channel: huddle.channelId,
        slack_channel_name: huddle.channelName,
        slack_message_ts: huddle.messageTs,
        slack_team_id: huddle.teamId,
        slack_canvas_id: huddle.fileId,
        huddle_date: huddle.huddleDate,
        ob1_type: claim.type,
        qualitative_confidence: claim.qualitative_confidence,
        topics: claim.topics,
        people: claim.people,
        related_to: [summaryEntryId]
      }
    }

    try {
      const claimResult: any = await deps.kms.callTool('unified_store', claimArgs)
      if (claimResult?.status === 'dedup_required') {
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

  if (claimFailures.length > 0) {
    console.warn(
      `⚠️  Huddle in #${huddle.channelName} (${huddle.fileId}) had ` +
        `${claimFailures.length}/${distilled.claims.length} claim failure(s):\n  ${claimFailures.join('\n  ')}`
    )
  }

  return {
    status: 'ok',
    huddle,
    summaryEntryId,
    claimEntryIds
  }
}

export async function runImport(deps: ImporterDeps): Promise<ImportReport> {
  const huddlesAll = await deps.source.list()
  const huddles = deps.opts.maxHuddles
    ? huddlesAll.slice(0, deps.opts.maxHuddles)
    : huddlesAll

  console.log(
    `📥 Loaded ${huddles.length} huddle(s) from source ` +
      `(workspace=${deps.opts.workspace}, source=${deps.opts.source})`
  )

  const report: ImportReport = {
    totalHuddles: huddles.length,
    summaries: 0,
    claims: 0,
    skipped: [],
    failed: [],
    dedupRefused: []
  }

  const t0 = Date.now()
  for (let i = 0; i < huddles.length; i++) {
    const huddle = huddles[i]
    const result = await processHuddle(huddle, deps)

    switch (result.status) {
      case 'ok':
        report.summaries += 1
        report.claims += result.claimEntryIds?.length ?? 0
        deps.log.completed.push(huddle.fileId)
        if (!deps.opts.dryRun) saveSyncLog(deps.opts.syncLogPath, deps.log)
        break
      case 'skipped':
        report.skipped.push({ fileId: huddle.fileId, channel: huddle.channelName })
        break
      case 'failed':
        report.failed.push({
          fileId: huddle.fileId,
          channel: huddle.channelName,
          reason: result.reason ?? 'unknown'
        })
        console.error(
          `❌ Huddle ${huddle.fileId} in #${huddle.channelName} failed: ${result.reason}`
        )
        break
      case 'dedup_refused':
        report.dedupRefused.push({
          fileId: huddle.fileId,
          channel: huddle.channelName,
          candidates: result.candidates ?? []
        })
        console.warn(
          `🛑 Huddle ${huddle.fileId} in #${huddle.channelName} refused by dedup gate ` +
            `against ${result.candidates?.[0]?.id ?? '?'}`
        )
        break
    }

    if ((i + 1) % 5 === 0 || i === huddles.length - 1) {
      const elapsedMs = Date.now() - t0
      const perHuddle = elapsedMs / (i + 1)
      const remaining = huddles.length - (i + 1)
      const etaMin = Math.round((perHuddle * remaining) / 60000)
      console.log(
        `⏱️  ${i + 1}/${huddles.length} done, ETA ${etaMin}min, last_channel=#${huddle.channelName}`
      )
    }
  }

  return report
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

/**
 * Distiller used in --dry-run when we still want to walk the whole pipeline.
 */
class NoopDistiller implements DistillerLike {
  async distill(huddle: RawHuddle): Promise<DistilledHuddle> {
    return {
      summary: `[dry-run stub] huddle ${huddle.fileId} in #${huddle.channelName} — would distill ${huddle.canvasMarkdown.length} chars`,
      claims: [
        {
          type: 'context',
          content: `[dry-run stub] context placeholder for huddle in #${huddle.channelName}`,
          qualitative_confidence: 'tentative',
          topics: ['dry-run'],
          people: []
        }
      ]
    }
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv)

  if (opts.source === 'file' && !opts.input) {
    console.error('❌ --source file requires --input <file>.')
    process.exit(2)
  }
  if (opts.source === 'live') {
    // Live mode requires the runtime to inject Slack MCP callbacks via the
    // exported runImportLive function below. The plain CLI cannot do this.
    console.error(
      `❌ --source live cannot be invoked from the bare CLI; it requires the
   runtime (a Claude Code session with Slack MCP authorized) to call
   runImportLive() with searchPublic + readCanvas callbacks.

   For unattended runs, use --source file --input <dump.json> after dumping
   huddles from a Claude Code session via slack_search_public + slack_read_canvas.`
    )
    process.exit(2)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey && !opts.dryRun) {
    console.error('❌ ANTHROPIC_API_KEY env var is required (Haiku 4.5 distillation).')
    console.error('   Set it directly or via doppler. Use --dry-run to skip distillation.')
    process.exit(2)
  }

  console.log(`🚀 Slack Huddle → KMS importer starting`)
  console.log(`   Source:       ${opts.source}`)
  if (opts.input) console.log(`   Input:        ${opts.input}`)
  console.log(`   KMS URL:      ${opts.kmsUrl}`)
  console.log(`   Sync log:     ${opts.syncLogPath}`)
  console.log(`   User ID:      ${opts.userId}`)
  console.log(`   Workspace:    ${opts.workspace}`)
  console.log(`   Model:        ${opts.anthropicModel}`)
  console.log(`   Dry run:      ${opts.dryRun}`)
  if (opts.maxHuddles) console.log(`   Cap:          ${opts.maxHuddles} huddles`)

  const source: SlackHuddleSource = new FileSlackSource(opts.input!)
  const distiller = opts.dryRun
    ? new NoopDistiller()
    : new HaikuDistiller(apiKey!, opts.anthropicModel)

  let kms: MinimalMcpClient | null = null
  if (!opts.dryRun) {
    let bearer: string | null = null
    try {
      bearer = await fetchBearerTokenIfNeeded(opts)
    } catch (e) {
      console.error(`❌ Could not obtain KMS bearer token: ${e instanceof Error ? e.message : e}`)
      process.exit(2)
    }
    kms = new MinimalMcpClient(opts.kmsUrl, bearer)
    await kms.initialize()
    console.log(`🔌 Connected to KMS, session active.`)
  }

  const log = loadSyncLog(opts.syncLogPath)
  console.log(`📓 Sync log has ${log.completed.length} previously-completed canvas(es).`)

  const report = await runImport({ source, distiller, kms, opts, log })

  if (kms) await kms.close()

  console.log(`\n══════════════ FINAL REPORT ══════════════`)
  console.log(`Total huddles:        ${report.totalHuddles}`)
  console.log(`Summary entries:      ${report.summaries}`)
  console.log(`Claim entries:        ${report.claims}`)
  console.log(`Skipped (sync log):   ${report.skipped.length}`)
  console.log(`Dedup refused:        ${report.dedupRefused.length}`)
  console.log(`Failed:               ${report.failed.length}`)
  if (report.failed.length > 0) {
    console.log(`\nFailures:`)
    for (const f of report.failed) {
      console.log(`  - #${f.channel} (${f.fileId}): ${f.reason}`)
    }
  }
  if (report.dedupRefused.length > 0) {
    console.log(`\nDedup refused (already in KMS):`)
    for (const d of report.dedupRefused) {
      console.log(`  - #${d.channel} (${d.fileId}) → top candidate ${d.candidates[0]?.id ?? '?'}`)
    }
  }
  console.log(`\n✅ Done.`)

  // Non-zero exit if any huddle hard-failed (dedup refusal is informational).
  process.exit(report.failed.length > 0 ? 1 : 0)
}

/**
 * Programmatic live entrypoint — for callers (a Claude Code session) that
 * have the Slack MCP tools available and want to wire them in. The CLI can
 * not invoke this path; it has no way to reach the Slack MCP from the bare
 * Node process.
 *
 * Usage from a Claude Code TS evaluator:
 *
 *   await runImportLive({
 *     opts: parseArgs(['--source', 'live', '--bearer-token', '...']),
 *     searchPublic: (q, o) => mcp__Slack__slack_search_public({ query: q, limit: o.limit, sort: o.sort }),
 *     readCanvas:   (id) => mcp__Slack__slack_read_canvas({ canvas_id: id })
 *   })
 */
export async function runImportLive(args: {
  opts: CliOptions
  searchPublic: (
    query: string,
    opts: { limit: number; sort?: string }
  ) => Promise<{ messages: SlackSearchMessage[] }>
  readCanvas: (canvasId: string) => Promise<{ canvas_markdown: string } | string>
  apiKey?: string
}): Promise<ImportReport> {
  const { opts, searchPublic, readCanvas } = args
  const apiKey = args.apiKey ?? process.env.ANTHROPIC_API_KEY ?? ''
  if (!apiKey && !opts.dryRun) {
    throw new Error('ANTHROPIC_API_KEY required (or pass apiKey argument). Use opts.dryRun=true to skip.')
  }
  const source = new LiveSlackSource(
    { searchPublic, readCanvas },
    { searchQuery: opts.searchQuery, searchLimit: opts.searchLimit }
  )
  const distiller = opts.dryRun
    ? new NoopDistiller()
    : new HaikuDistiller(apiKey, opts.anthropicModel)
  let kms: MinimalMcpClient | null = null
  if (!opts.dryRun) {
    const bearer = await fetchBearerTokenIfNeeded(opts)
    kms = new MinimalMcpClient(opts.kmsUrl, bearer)
    await kms.initialize()
  }
  const log = loadSyncLog(opts.syncLogPath)
  const report = await runImport({ source, distiller, kms, opts, log })
  if (kms) await kms.close()
  return report
}
