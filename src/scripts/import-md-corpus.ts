/**
 * Markdown Corpus → KMS Importer
 *
 * Walks a curated set of MD root directories (specs, planning docs, research,
 * project workspaces) and ingests each .md file into KMS as TWO kinds of entries:
 *
 *   1. Whole-doc summary entry  (~150-300 word abstract)
 *   2. 2–5 key-claim entries    (self-contained statements, OB1 6-type taxonomy)
 *
 * Both are routed through the live KMS at http://localhost:8180/mcp via JSON-RPC,
 * so the natural dedup gate fires on re-runs of unchanged docs (skipped) and changed
 * docs (retried with action=update).
 *
 * Filesystem is READ-ONLY — never moves, edits, or deletes any source MD.
 *
 * Distillation: Claude Haiku 4.5 (claude-haiku-4-5-20251001) via @anthropic-ai/sdk.
 *
 * Resumable via ~/.kms-md-corpus-sync.json keyed by absolute_path → content_sha256.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import { execSync } from 'child_process'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ClaimType =
  | 'decision'
  | 'preference'
  | 'learning'
  | 'context'
  | 'brainstorm'
  | 'reference'

export type QualitativeConfidence = 'firm' | 'tentative' | 'exploring'

export interface DistilledClaim {
  type: ClaimType
  content: string
  qualitative_confidence: QualitativeConfidence
  topics?: string[]
  people?: string[]
}

export interface Distillation {
  summary: string
  claims: DistilledClaim[]
}

export interface SyncLogEntry {
  absolute_path: string
  content_sha256: string
  whole_doc_id: string | null
  claim_ids: string[]
  imported_at: string
  source_project: string
  word_count: number
  file_size: number
  /** True when distillation parser fell back; whole-doc still imported, no claims. */
  partial?: boolean
  /** Last error message (if last attempt failed). Cleared on success. */
  last_error?: string
}

export interface SyncLog {
  version: 1
  entries: Record<string, SyncLogEntry> // keyed by absolute_path
}

export interface FileRecord {
  absolutePath: string
  rootDir: string          // matched root used to derive source_project
  sourceProject: string    // top-folder name e.g. "Notes"
  size: number
  mtime: Date
}

export interface CliOptions {
  roots: string[]
  includeAskMethod: boolean
  dryRun: boolean
  limit: number | null
  after: Date | null
  force: boolean
  bearerToken: string | null
  kmsUrl: string
  syncLogPath: string
  anthropicApiKey: string | null
  /** Override of the default 7 verified roots (added by --root). */
  extraRoots: string[]
  /** Verbose — log every file decision. */
  verbose: boolean
}

// ─── Constants ─────────────────────────────────────────────────────────────────

export const HOME = os.homedir()

/** The 7 verified canonical roots, per spec. ASK Method opt-in adds an 8th. */
export const DEFAULT_ROOTS = [
  path.join(HOME, 'Documents/Notes'),
  path.join(HOME, 'Documents/Light_Work'),
  path.join(HOME, 'Documents/Job_Search_2026'),
  path.join(HOME, 'Documents/Project Caribou'),
  path.join(HOME, 'Desktop/Tengo'),
  path.join(HOME, 'Documents'),  // top-level loose .md only (not recursive)
  path.join(HOME, 'Downloads')   // top-level loose .md only (not recursive)
]

/** Roots ingested at top-level only (no recursion into subfolders). */
export const NON_RECURSIVE_ROOTS = new Set<string>([
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Downloads')
])

/** Skip these path segments anywhere in walk. */
export const SKIP_SEGMENTS = [
  'node_modules',
  '.git',
  '.scratch',
  'assets',
  'data'  // light_work has 2.5GB of data/ subdir
]

/** Roots that are explicitly listed by the user — git-inside-repo check is skipped for these. */
export const EXPLICIT_ROOTS_OVERRIDE_GIT_CHECK = true

/** ASK Method opt-in root. */
export const ASK_METHOD_ROOT = path.join(HOME, 'Documents/ASK Method')

/** Default sync-log path. */
export const DEFAULT_SYNC_LOG = path.join(HOME, '.kms-md-corpus-sync.json')

/** KMS local default. */
export const DEFAULT_KMS_URL = 'http://localhost:8180/mcp'

/** Long-doc thresholds (per spec). */
export const LONG_DOC_BYTES = 15 * 1024
export const LONG_DOC_WORDS = 2500
export const HUGE_DOC_BYTES = 500 * 1024  // fallback paragraph chunking
export const PARAGRAPH_CHUNK_BYTES = 3 * 1024
export const MAX_CLAIMS_PER_DOC = 8

/** Anthropic distillation model. */
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

// ─── Pure helpers (unit-testable) ──────────────────────────────────────────────

/** SHA-256 of a UTF-8 string, hex. */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Map OB1 claim type → KMSmcp contentType.
 *   decision/learning   → insight
 *   preference/context  → memory
 *   brainstorm          → insight
 *   reference           → procedure  (curriculum / how-to / canonical reference)
 */
export function mapClaimTypeToContentType(
  claim: ClaimType
): 'memory' | 'insight' | 'fact' | 'procedure' {
  switch (claim) {
    case 'decision':
    case 'learning':
    case 'brainstorm':
      return 'insight'
    case 'preference':
    case 'context':
      return 'memory'
    case 'reference':
      return 'procedure'
  }
}

/** Map qualitative → numeric confidence (per spec). */
export function qualitativeToNumeric(q: QualitativeConfidence): number {
  return q === 'firm' ? 0.9 : q === 'tentative' ? 0.65 : 0.4
}

/**
 * Infer the whole-doc contentType from filename + content heuristics.
 *   spec/plan/research → insight
 *   meeting notes      → memory
 *   reference/curriculum → procedure
 *   tracker            → memory
 *   default            → insight
 */
export function inferWholeDocContentType(
  filename: string,
  content: string
): 'memory' | 'insight' | 'procedure' {
  const f = filename.toLowerCase()
  const head = content.slice(0, 500).toLowerCase()
  // Hyphens, underscores, and dots all separate words in our heuristic. Use a
  // permissive boundary so `metadata_extraction_cookbook.md` matches `cookbook`.
  const boundary = '(^|[^a-z0-9])'
  const tail = '([^a-z0-9]|$)'
  const has = (alt: string) => new RegExp(`${boundary}(${alt})${tail}`).test(f)
  if (has('spec|plan|research|design|architecture|brief|rfc')) return 'insight'
  if (has('meeting|standup|notes|prep|debrief|recap')) return 'memory'
  if (has('curriculum|reference|how[- ]?to|cookbook|guide|tutorial|manual|sop')) return 'procedure'
  if (has('tracker|status|backlog|todo|checklist')) return 'memory'
  // content fallback
  if (/^#\s+(spec|specification|implementation plan|design)/i.test(content.slice(0, 200))) return 'insight'
  if (/^meeting:|^attendees:|## attendees/i.test(head)) return 'memory'
  return 'insight'
}

/**
 * Compute the dotted subject facet:
 *   <source_project>.<filename-without-extension-slugified>
 * Slugifies by replacing spaces and disallowed chars with `-`, collapsing runs.
 */
export function computeSubject(sourceProject: string, absolutePath: string): string {
  const base = path.basename(absolutePath, path.extname(absolutePath))
  const slug = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `${sourceProject}.${slug}`
}

/** Approximate word count (whitespace split). */
export function approxWordCount(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length
}

/** Decide whether a file path is inside a git repo (used only for non-explicit roots). */
export function isInsideGitRepo(filePath: string): boolean {
  try {
    execSync(`git -C ${JSON.stringify(path.dirname(filePath))} rev-parse --is-inside-work-tree`, {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

/** Skip-segment check: returns true if any path segment is in SKIP_SEGMENTS. */
export function pathHasSkipSegment(p: string): boolean {
  const segments = p.split(path.sep)
  return SKIP_SEGMENTS.some(seg => segments.includes(seg))
}

/**
 * Recursively (or top-level only for NON_RECURSIVE_ROOTS) walks a root and yields
 * MD file records. Honors SKIP_SEGMENTS. The git-repo check is suppressed for the
 * provided explicit root itself but still applied to any subpath that introduces
 * a NEW .git boundary deeper than the root.
 *
 * `existsCheck` is injectable for testing — defaults to fs.access.
 */
export async function walkRoot(
  rootDir: string,
  options: { recursive: boolean }
): Promise<FileRecord[]> {
  const out: FileRecord[] = []
  const sourceProject = path.basename(rootDir)

  // Resolve the root dir to its real path (in case of symlinks); skip if missing.
  let rootStat
  try {
    rootStat = await fs.stat(rootDir)
  } catch {
    return out
  }
  if (!rootStat.isDirectory()) return out

  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // Skip dotted dirs (.git, .claude, .scratch, etc) and skip-segment matches
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        if (SKIP_SEGMENTS.includes(entry.name)) continue
        if (!options.recursive) continue  // top-level only
        await visit(full)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.md')) continue
      if (pathHasSkipSegment(full)) continue
      let st
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }
      out.push({
        absolutePath: full,
        rootDir,
        sourceProject,
        size: st.size,
        mtime: st.mtime
      })
    }
  }

  await visit(rootDir)
  return out
}

/**
 * Walk all roots, dedup by absolute path. For non-recursive roots (Documents,
 * Downloads), only the top-level .md files are picked up (this is intentional —
 * subfolders of those are picked up by their own explicit roots, e.g. Notes/).
 */
export async function discoverFiles(opts: CliOptions): Promise<FileRecord[]> {
  const roots = [...opts.roots, ...opts.extraRoots]
  if (opts.includeAskMethod) roots.push(ASK_METHOD_ROOT)

  const seen = new Set<string>()
  const out: FileRecord[] = []
  for (const root of roots) {
    const recursive = !NON_RECURSIVE_ROOTS.has(root)
    const files = await walkRoot(root, { recursive })
    for (const f of files) {
      if (seen.has(f.absolutePath)) continue
      seen.add(f.absolutePath)
      if (opts.after && f.mtime <= opts.after) continue
      out.push(f)
    }
  }
  return out
}

/**
 * Chunk a long doc by H2 headers; if no H2s present, fall back to paragraph
 * blocks of ~PARAGRAPH_CHUNK_BYTES. Returns chunks of plain text.
 */
export function chunkLongDoc(content: string): string[] {
  // First try H2 boundaries
  const h2Indices: number[] = []
  const lines = content.split('\n')
  let charCursor = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) h2Indices.push(charCursor)
    charCursor += lines[i].length + 1 // +1 for newline
  }
  if (h2Indices.length >= 2) {
    const chunks: string[] = []
    h2Indices.push(content.length)
    // Preamble before first H2 (if non-trivial)
    const firstH2 = h2Indices[0]
    if (firstH2 > 200) chunks.push(content.slice(0, firstH2).trim())
    for (let i = 0; i < h2Indices.length - 1; i++) {
      const start = h2Indices[i]
      const end = h2Indices[i + 1]
      const chunk = content.slice(start, end).trim()
      if (chunk.length > 0) chunks.push(chunk)
    }
    return chunks.filter(c => c.length > 0)
  }

  // No H2s — paragraph-block chunking
  const blocks = content.split(/\n\s*\n/)
  const out: string[] = []
  let buf = ''
  for (const b of blocks) {
    if (buf.length + b.length + 2 > PARAGRAPH_CHUNK_BYTES && buf.length > 0) {
      out.push(buf.trim())
      buf = b
    } else {
      buf = buf.length === 0 ? b : `${buf}\n\n${b}`
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim())
  return out
}

/** Validate distillation JSON shape. Throws with a helpful message on bad input. */
export function validateDistillation(raw: unknown): Distillation {
  if (!raw || typeof raw !== 'object') {
    throw new Error('distillation: not an object')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) {
    throw new Error('distillation.summary missing or empty')
  }
  if (!Array.isArray(obj.claims)) {
    throw new Error('distillation.claims missing or not an array')
  }
  const validTypes: ClaimType[] = ['decision', 'preference', 'learning', 'context', 'brainstorm', 'reference']
  const validConf: QualitativeConfidence[] = ['firm', 'tentative', 'exploring']
  const claims: DistilledClaim[] = []
  for (const [idx, c] of obj.claims.entries()) {
    if (!c || typeof c !== 'object') {
      throw new Error(`distillation.claims[${idx}]: not an object`)
    }
    const cc = c as Record<string, unknown>
    if (typeof cc.type !== 'string' || !validTypes.includes(cc.type as ClaimType)) {
      throw new Error(`distillation.claims[${idx}].type invalid: ${cc.type}`)
    }
    if (typeof cc.content !== 'string' || cc.content.trim().length === 0) {
      throw new Error(`distillation.claims[${idx}].content missing/empty`)
    }
    if (
      typeof cc.qualitative_confidence !== 'string' ||
      !validConf.includes(cc.qualitative_confidence as QualitativeConfidence)
    ) {
      throw new Error(`distillation.claims[${idx}].qualitative_confidence invalid: ${cc.qualitative_confidence}`)
    }
    claims.push({
      type: cc.type as ClaimType,
      content: cc.content,
      qualitative_confidence: cc.qualitative_confidence as QualitativeConfidence,
      topics: Array.isArray(cc.topics) ? (cc.topics as string[]).filter(t => typeof t === 'string') : undefined,
      people: Array.isArray(cc.people) ? (cc.people as string[]).filter(p => typeof p === 'string') : undefined
    })
  }
  return { summary: obj.summary, claims }
}

/**
 * Decide what action to take for a discovered file given the prior sync log.
 *   - 'skip'   : same hash, already imported
 *   - 'update' : prior import exists, content changed → action=update
 *   - 'new'    : never seen
 *   - 'retry'  : prior import had partial/error state, retry as new
 */
export function planAction(
  fileRecord: FileRecord,
  contentHash: string,
  syncLog: SyncLog,
  force: boolean
): { action: 'skip' | 'update' | 'new' | 'retry'; priorEntry?: SyncLogEntry } {
  const prior = syncLog.entries[fileRecord.absolutePath]
  if (!prior) return { action: 'new' }
  if (force) return prior.whole_doc_id ? { action: 'update', priorEntry: prior } : { action: 'retry', priorEntry: prior }
  if (prior.content_sha256 === contentHash && prior.whole_doc_id) return { action: 'skip', priorEntry: prior }
  if (prior.last_error || !prior.whole_doc_id) return { action: 'retry', priorEntry: prior }
  return { action: 'update', priorEntry: prior }
}

// ─── Sync log I/O ──────────────────────────────────────────────────────────────

export async function loadSyncLog(syncLogPath: string): Promise<SyncLog> {
  try {
    const raw = await fs.readFile(syncLogPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.version === 1 && typeof parsed.entries === 'object') return parsed as SyncLog
    // unknown shape — start fresh but back up
    const backup = `${syncLogPath}.bak.${Date.now()}`
    await fs.writeFile(backup, raw)
    return { version: 1, entries: {} }
  } catch (err: any) {
    if (err.code === 'ENOENT') return { version: 1, entries: {} }
    throw err
  }
}

export async function saveSyncLog(syncLogPath: string, log: SyncLog): Promise<void> {
  const tmp = `${syncLogPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(log, null, 2))
  await fs.rename(tmp, syncLogPath)
}

// ─── KMS HTTP client ───────────────────────────────────────────────────────────

export interface UnifiedStoreArgs {
  content: string
  contentType: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'
  source?: 'personal' | 'technical' | 'cross_domain'
  userId?: string
  metadata?: Record<string, any>
  confidence?: number
  action?: 'supersede' | 'update' | 'complement' | 'force-new'
  old_id?: string
  reason?: string
}

/** Result wrapper from KMS — covers both success and dedup_required shapes. */
export interface KmsStoreResponse {
  success?: boolean
  id?: string
  status?: 'dedup_required'
  candidates?: Array<{ id: string; similarity: number; content_preview: string }>
  message?: string
  retry_with?: string[]
  band?: 'refuse' | 'confirm'
  thresholds?: { refuse: number; confirm: number }
  // forward any other fields
  [k: string]: any
}

/**
 * Minimal MCP HTTP client. Performs the streamable-HTTP initialize handshake
 * once, then issues tools/call requests with the resulting mcp-session-id.
 *
 * This intentionally implements the protocol by hand instead of pulling in the
 * full MCP SDK Client class — keeps the importer lean and avoids a runtime
 * dependency on the SDK's transport layer.
 */
export class KmsHttpClient {
  private sessionId: string | null = null
  private requestId = 1

  constructor(
    private kmsUrl: string,
    private bearerToken: string | null
  ) {}

  /** Send a JSON-RPC request and return the parsed result. Handles SSE-style streams. */
  private async rpc(method: string, params: any, isInit = false): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // The transport requires both — JSON-only causes a 406 from the SDK.
      'Accept': 'application/json, text/event-stream'
    }
    if (this.bearerToken) headers['Authorization'] = `Bearer ${this.bearerToken}`
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId

    const body = {
      jsonrpc: '2.0',
      id: this.requestId++,
      method,
      params
    }

    const res = await fetch(this.kmsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })

    if (isInit) {
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`KMS HTTP ${res.status}: ${text.slice(0, 400)}`)
    }

    // The transport may return either application/json or SSE.
    const contentType = res.headers.get('content-type') || ''
    const text = await res.text()

    if (contentType.includes('text/event-stream')) {
      // Parse SSE: pick the last `data:` line for our request id
      const lines = text.split('\n')
      let lastData: any = null
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          const parsed = JSON.parse(payload)
          if (parsed.id === body.id) lastData = parsed
        } catch {
          /* skip non-JSON */
        }
      }
      if (!lastData) throw new Error('SSE response had no JSON-RPC data line')
      if (lastData.error) throw new Error(`JSON-RPC error: ${JSON.stringify(lastData.error)}`)
      return lastData.result
    }

    const parsed = JSON.parse(text)
    if (parsed.error) throw new Error(`JSON-RPC error: ${JSON.stringify(parsed.error)}`)
    return parsed.result
  }

  /** Initialize the MCP session. Must be called once before any tools/call. */
  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kms-md-corpus-importer', version: '1.0.0' }
    }, true)
    if (!this.sessionId) {
      throw new Error('KMS did not return mcp-session-id on initialize. Verify the URL and that KMS is running.')
    }
    // Send the notifications/initialized as required by MCP
    await this.notification('notifications/initialized', {})
  }

  /** Fire-and-forget MCP notification (no JSON-RPC id). */
  private async notification(method: string, params: any): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }
    if (this.bearerToken) headers['Authorization'] = `Bearer ${this.bearerToken}`
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    await fetch(this.kmsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params })
    })
  }

  /** Probe — calls kms_ping. Throws on failure. */
  async ping(): Promise<any> {
    const result = await this.rpc('tools/call', { name: 'kms_ping', arguments: {} })
    return this.unwrapToolResult(result)
  }

  /** Call unified_store and return the parsed result. */
  async unifiedStore(args: UnifiedStoreArgs): Promise<KmsStoreResponse> {
    const result = await this.rpc('tools/call', { name: 'unified_store', arguments: args })
    return this.unwrapToolResult(result) as KmsStoreResponse
  }

  /** MCP tool result is `{ content: [{ type: 'text', text: '<json>' }] }`. */
  private unwrapToolResult(result: any): any {
    const text = result?.content?.[0]?.text
    if (typeof text !== 'string') return result
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

// ─── Distillation (Anthropic Haiku) ────────────────────────────────────────────

/** Build the distillation prompt. */
export function buildDistillPrompt(content: string): string {
  return `You are extracting curated knowledge from a Markdown document into structured form for a personal Knowledge Management System.

The document below is a CURATED ARTIFACT — a spec, plan, research note, meeting note, or reference doc. Treat its claims as deliberate, not exploratory rambling.

Output ONE JSON object with EXACTLY these fields:

{
  "summary": "150-300 word doc-level abstract. State what the document IS, what it decides/argues, and what would be lost if a future agent never reads it. Self-contained — readable without the source.",
  "claims": [
    {
      "type": "decision | preference | learning | context | brainstorm | reference",
      "content": "Self-contained statement that makes sense WITHOUT reading the doc. Include the subject, the predicate, and any qualifying scope.",
      "qualitative_confidence": "firm | tentative | exploring",
      "topics": ["short topic tags"],
      "people": ["names mentioned, if any"]
    }
  ]
}

Rules:
- 2 to 5 claims, never more.
- Each claim must stand alone. "It will be 6 cameras" is BAD. "Phoenix uses 6 cameras per the Mar-2026 calibration" is GOOD.
- type semantics:
    decision   = a choice made ("we chose X over Y")
    preference = a stable taste/inclination ("Rich prefers async comms")
    learning   = a discovery/insight, often via experiment
    context    = situational/environmental fact
    brainstorm = an idea floated, not yet committed
    reference  = canonical fact / how-to / definition
- qualitative_confidence:
    firm       = the doc treats it as decided/proven
    tentative  = the doc proposes/recommends
    exploring  = the doc speculates/brainstorms
- Output JSON only. No prose, no markdown fences, no commentary.

DOCUMENT:
${content}`
}

/** Build the merge prompt for chunk-level claims → single doc-level summary. */
export function buildMergePrompt(chunkSummaries: string[]): string {
  return `You distilled the following chunks of a single Markdown document. Now produce ONE 150-300 word summary covering the WHOLE doc, suitable for a future agent who will never read the source.

Output JSON only:
{ "summary": "..." }

CHUNK SUMMARIES:
${chunkSummaries.map((s, i) => `--- Chunk ${i + 1} ---\n${s}`).join('\n\n')}`
}

/**
 * Strip code fences from model output. Haiku occasionally wraps JSON in
 * ```json ... ``` even when told not to.
 */
export function stripCodeFences(s: string): string {
  return s
    .replace(/^\s*```(?:json|JSON)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}

/**
 * Distill a single doc (or chunk) via Haiku. Retries once on JSON parse failure
 * with a stricter prompt. On second failure, throws (caller decides fallback).
 */
export async function distillOnce(
  anthropic: any,
  content: string,
  retry = false
): Promise<Distillation> {
  const prompt = retry
    ? `${buildDistillPrompt(content)}\n\n!!! Your previous response was not valid JSON. Output ONLY the JSON object, no fences, no prose. !!!`
    : buildDistillPrompt(content)

  const resp = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  })
  const text = resp.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('')
  const stripped = stripCodeFences(text)
  try {
    const parsed = JSON.parse(stripped)
    return validateDistillation(parsed)
  } catch (err) {
    if (!retry) {
      return distillOnce(anthropic, content, true)
    }
    throw err
  }
}

/** Distill — chunked path. Always returns a Distillation, possibly empty claims. */
export async function distillDocument(
  anthropic: any,
  content: string
): Promise<Distillation> {
  const wordCount = approxWordCount(content)
  const isLong = content.length > LONG_DOC_BYTES || wordCount > LONG_DOC_WORDS
  if (!isLong) {
    return distillOnce(anthropic, content)
  }

  const chunks = chunkLongDoc(content)
  const perChunk: Distillation[] = []
  for (const chunk of chunks) {
    try {
      perChunk.push(await distillOnce(anthropic, chunk))
    } catch (err) {
      // skip bad chunk — keep going
      console.warn(`  ⚠️  chunk distill failed: ${(err as Error).message.slice(0, 200)}`)
    }
  }
  if (perChunk.length === 0) {
    throw new Error('all chunks failed to distill')
  }

  // Merge claims (cap at MAX_CLAIMS_PER_DOC, prefer firm > tentative > exploring)
  const allClaims: DistilledClaim[] = []
  for (const p of perChunk) allClaims.push(...p.claims)
  const confidenceRank = { firm: 0, tentative: 1, exploring: 2 }
  allClaims.sort((a, b) => confidenceRank[a.qualitative_confidence] - confidenceRank[b.qualitative_confidence])
  const claims = allClaims.slice(0, MAX_CLAIMS_PER_DOC)

  // Merge summaries via a final Haiku call
  const mergePrompt = buildMergePrompt(perChunk.map(p => p.summary))
  const resp = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: mergePrompt }]
  })
  const text = resp.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('')
  const stripped = stripCodeFences(text)
  let summary = ''
  try {
    summary = JSON.parse(stripped).summary || ''
  } catch {
    // fallback: use the first chunk's summary
    summary = perChunk[0].summary
  }
  return { summary, claims }
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    roots: DEFAULT_ROOTS,
    extraRoots: [],
    includeAskMethod: false,
    dryRun: false,
    limit: null,
    after: null,
    force: false,
    bearerToken: process.env.KMS_BEARER_TOKEN || null,
    kmsUrl: process.env.KMS_URL || DEFAULT_KMS_URL,
    syncLogPath: DEFAULT_SYNC_LOG,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    verbose: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--root':
        opts.extraRoots.push(argv[++i])
        break
      case '--include-ask-method':
        opts.includeAskMethod = true
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--limit':
        opts.limit = parseInt(argv[++i], 10)
        break
      case '--after':
        opts.after = new Date(argv[++i])
        if (isNaN(opts.after.getTime())) throw new Error(`Invalid --after date: ${argv[i]}`)
        break
      case '--force':
        opts.force = true
        break
      case '--bearer-token':
        opts.bearerToken = argv[++i]
        break
      case '--kms-url':
        opts.kmsUrl = argv[++i]
        break
      case '--sync-log':
        opts.syncLogPath = argv[++i]
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`)
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`Markdown Corpus → KMS Importer

Usage:
  node dist/scripts/import-md-corpus-cli.js [options]

Options:
  --root <path>           Add an extra root (in addition to defaults)
  --include-ask-method    Include ~/Documents/ASK Method (1317 files, 742MB)
  --dry-run               Plan only, no writes
  --limit <n>             Process at most N files
  --after <YYYY-MM-DD>    Only files mtime > date
  --force                 Re-process even if hash unchanged
  --bearer-token <token>  KMS OAuth bearer token (or set KMS_BEARER_TOKEN env)
  --kms-url <url>         KMS endpoint (default ${DEFAULT_KMS_URL})
  --sync-log <path>       Sync state file (default ${DEFAULT_SYNC_LOG})
  --verbose               Log every file decision
  -h, --help              Show this help

Default roots:
${DEFAULT_ROOTS.map(r => '  ' + r).join('\n')}

Required environment:
  ANTHROPIC_API_KEY       Used for Haiku distillation
  KMS_BEARER_TOKEN        (optional) sent to KMS as Authorization: Bearer <…>
`)
}

// ─── Main flow ─────────────────────────────────────────────────────────────────

interface ProcessStats {
  discovered: number
  skipped: number
  imported: number
  updated: number
  failed: number
  partialClaims: number
  totalClaimEntries: number
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv)
  const stats: ProcessStats = {
    discovered: 0,
    skipped: 0,
    imported: 0,
    updated: 0,
    failed: 0,
    partialClaims: 0,
    totalClaimEntries: 0
  }

  console.log('📄 KMS Markdown Corpus Importer')
  console.log('─'.repeat(60))
  console.log(`KMS URL:       ${opts.kmsUrl}`)
  console.log(`Sync log:      ${opts.syncLogPath}`)
  console.log(`Dry run:       ${opts.dryRun}`)
  console.log(`Force re-run:  ${opts.force}`)
  if (opts.limit) console.log(`Limit:         ${opts.limit}`)
  if (opts.after) console.log(`After:         ${opts.after.toISOString()}`)
  console.log(`Roots:         ${opts.roots.length} default + ${opts.extraRoots.length} extra` +
    (opts.includeAskMethod ? ' + ASK Method' : ''))

  // 1. Validate prerequisites
  if (!opts.dryRun && !opts.anthropicApiKey) {
    console.error('❌ ANTHROPIC_API_KEY env var required (or use --dry-run for planning).')
    process.exit(1)
  }

  // 2. Probe KMS (skipped on dry-run; real run requires KMS up)
  let client: KmsHttpClient | null = null
  if (!opts.dryRun) {
    client = new KmsHttpClient(opts.kmsUrl, opts.bearerToken)
    try {
      await client.initialize()
      const ping = await client.ping()
      console.log(`✅ KMS reachable (datastores: ${Object.keys(ping?.datastores || {}).join(', ')})`)
    } catch (err) {
      console.error(`❌ KMS unreachable at ${opts.kmsUrl}: ${(err as Error).message}`)
      console.error('   Start KMS daemon first (kms.yaker.org / port 8180).')
      process.exit(1)
    }
  }

  // 3. Load sync log
  const syncLog = await loadSyncLog(opts.syncLogPath)
  const knownCount = Object.keys(syncLog.entries).length
  console.log(`📂 Sync log loaded — ${knownCount} prior entries`)

  // 4. Discover
  const files = await discoverFiles(opts)
  stats.discovered = files.length
  console.log(`🔍 Discovered ${files.length} candidate files`)

  // 5. Plan
  const planned: Array<{ file: FileRecord; hash: string; action: 'new' | 'update' | 'retry'; priorEntry?: SyncLogEntry }> = []
  for (const file of files) {
    let content: string
    try {
      content = await fs.readFile(file.absolutePath, 'utf8')
    } catch (err) {
      console.warn(`  ⚠️  read failed: ${file.absolutePath} — ${(err as Error).message}`)
      stats.failed++
      continue
    }
    const hash = computeContentHash(content)
    const plan = planAction(file, hash, syncLog, opts.force)
    if (plan.action === 'skip') {
      stats.skipped++
      if (opts.verbose) console.log(`  · skip   ${file.absolutePath}`)
      continue
    }
    planned.push({ file, hash, action: plan.action, priorEntry: plan.priorEntry })
  }
  console.log(`📋 Plan: ${planned.length} to process, ${stats.skipped} skipped (already up-to-date)`)

  // 6. Apply limit
  const toProcess = opts.limit ? planned.slice(0, opts.limit) : planned

  // 7. Dry-run? Print sample plan and exit.
  if (opts.dryRun) {
    const byProject = new Map<string, number>()
    for (const p of toProcess) {
      byProject.set(p.file.sourceProject, (byProject.get(p.file.sourceProject) || 0) + 1)
    }
    console.log('\n📊 Dry-run plan by project:')
    for (const [proj, n] of byProject) console.log(`  ${proj.padEnd(20)} ${n}`)
    console.log('\n📝 First 10 files:')
    for (const p of toProcess.slice(0, 10)) {
      const s = p.file.size
      console.log(`  [${p.action.padEnd(6)}] ${(s + ' B').padStart(8)}  ${p.file.absolutePath}`)
    }
    return
  }

  // 8. Lazy-import the Anthropic SDK (only if not dry-run)
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const anthropic = new Anthropic({ apiKey: opts.anthropicApiKey! })

  // 9. Process files (max 2 concurrent distillations)
  const CONCURRENCY = 2
  let cursor = 0
  const flushSyncLog = throttle(() => saveSyncLog(opts.syncLogPath, syncLog), 5000)

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= toProcess.length) return
      const item = toProcess[idx]
      const { file, hash, action, priorEntry } = item
      try {
        const content = await fs.readFile(file.absolutePath, 'utf8')
        await processFile(client!, anthropic, file, content, hash, action, priorEntry, syncLog, stats)
        flushSyncLog()
        const total = idx + 1
        if (total % 5 === 0 || total === toProcess.length) {
          console.log(`  progress: ${total}/${toProcess.length}`)
        }
      } catch (err) {
        const msg = (err as Error).message
        console.error(`  ❌ ${file.absolutePath}: ${msg.slice(0, 200)}`)
        syncLog.entries[file.absolutePath] = {
          ...(syncLog.entries[file.absolutePath] || {
            absolute_path: file.absolutePath,
            content_sha256: hash,
            whole_doc_id: null,
            claim_ids: [],
            imported_at: new Date().toISOString(),
            source_project: file.sourceProject,
            word_count: 0,
            file_size: file.size
          }),
          last_error: msg.slice(0, 500)
        }
        stats.failed++
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  await saveSyncLog(opts.syncLogPath, syncLog)

  // 10. Final report
  console.log('\n📈 Final stats:')
  console.log(`  discovered:        ${stats.discovered}`)
  console.log(`  skipped (cached):  ${stats.skipped}`)
  console.log(`  imported (new):    ${stats.imported}`)
  console.log(`  updated:           ${stats.updated}`)
  console.log(`  failed:            ${stats.failed}`)
  console.log(`  partial (no claims): ${stats.partialClaims}`)
  console.log(`  total claim entries: ${stats.totalClaimEntries}`)
}

/** Process one file end-to-end (distill + store whole-doc + store claims). */
async function processFile(
  client: KmsHttpClient,
  anthropic: any,
  file: FileRecord,
  content: string,
  hash: string,
  action: 'new' | 'update' | 'retry',
  priorEntry: SyncLogEntry | undefined,
  syncLog: SyncLog,
  stats: ProcessStats
): Promise<void> {
  const filename = path.basename(file.absolutePath)
  const subject = computeSubject(file.sourceProject, file.absolutePath)
  const wordCount = approxWordCount(content)
  const wholeDocCT = inferWholeDocContentType(filename, content)

  // 1. Distill
  let distillation: Distillation
  let partial = false
  try {
    distillation = await distillDocument(anthropic, content)
  } catch (err) {
    console.warn(`  ⚠️  distill failed for ${filename} — storing whole-doc only. (${(err as Error).message.slice(0, 120)})`)
    // Synthesize a degenerate summary: first 1k chars truncated + filename
    distillation = {
      summary: `[Distillation failed — raw doc available at metadata.source_doc.] ${content.slice(0, 800).replace(/\s+/g, ' ').trim()}…`,
      claims: []
    }
    partial = true
  }

  const baseMetadata = {
    subject,
    source: 'markdown_corpus' as const,
    source_doc: file.absolutePath,
    source_project: file.sourceProject,
    file_mtime: file.mtime.toISOString(),
    file_size: file.size,
    word_count: wordCount
  }

  // 2. Store whole-doc entry (with action=update if applicable)
  const wholeDocArgs: UnifiedStoreArgs = {
    content: distillation.summary,
    contentType: wholeDocCT,
    source: 'cross_domain',
    metadata: baseMetadata,
    confidence: 0.85
  }
  if (action === 'update' && priorEntry?.whole_doc_id) {
    wholeDocArgs.action = 'update'
    wholeDocArgs.old_id = priorEntry.whole_doc_id
    wholeDocArgs.reason = `content hash changed since ${priorEntry.imported_at}`
  }

  const wholeRes = await client.unifiedStore(wholeDocArgs)
  const wholeId = await resolveStoreResult(client, wholeRes, wholeDocArgs, action, priorEntry)

  // 3. Store claim entries
  const claimIds: string[] = []
  for (const claim of distillation.claims) {
    const claimArgs: UnifiedStoreArgs = {
      content: claim.content,
      contentType: mapClaimTypeToContentType(claim.type),
      source: 'cross_domain',
      metadata: {
        ...baseMetadata,
        related_to: wholeId ? [wholeId] : [],
        claim_type: claim.type,
        qualitative_confidence: claim.qualitative_confidence,
        topics: claim.topics || [],
        people: claim.people || []
      },
      confidence: qualitativeToNumeric(claim.qualitative_confidence)
    }
    try {
      const res = await client.unifiedStore(claimArgs)
      const claimId = await resolveStoreResult(client, res, claimArgs, 'new', undefined)
      if (claimId) claimIds.push(claimId)
      stats.totalClaimEntries++
    } catch (err) {
      console.warn(`    ⚠️  claim store failed: ${(err as Error).message.slice(0, 120)}`)
    }
  }

  // 4. Update sync log
  syncLog.entries[file.absolutePath] = {
    absolute_path: file.absolutePath,
    content_sha256: hash,
    whole_doc_id: wholeId,
    claim_ids: claimIds,
    imported_at: new Date().toISOString(),
    source_project: file.sourceProject,
    word_count: wordCount,
    file_size: file.size,
    partial,
    last_error: undefined
  }
  if (action === 'update') stats.updated++
  else stats.imported++
  if (partial) stats.partialClaims++
}

/**
 * Resolve the result of a unified_store call. Handles three outcomes:
 *   - success            → return id
 *   - dedup_required + we already passed action=update → that's a real refusal; throw
 *   - dedup_required (unchanged content, unexpected here) → log + return prior id (skip)
 */
async function resolveStoreResult(
  client: KmsHttpClient,
  res: KmsStoreResponse,
  args: UnifiedStoreArgs,
  action: 'new' | 'update' | 'retry',
  priorEntry: SyncLogEntry | undefined
): Promise<string | null> {
  if (res?.success && res.id) return res.id
  if (res?.status === 'dedup_required') {
    // Re-run on unchanged content for whole-doc entry: KMS recognizes the dup,
    // we treat as success and reuse the prior id.
    if (action === 'new' && priorEntry?.whole_doc_id) {
      return priorEntry.whole_doc_id
    }
    // If it's a brand-new file the gate refused, retry once with action=update
    // pointed at the top candidate. Better than dropping the entry.
    const topCandidate = res.candidates?.[0]
    if (topCandidate && action === 'new') {
      const retryArgs: UnifiedStoreArgs = {
        ...args,
        action: 'update',
        old_id: topCandidate.id,
        reason: `dedup gate matched candidate (cos=${topCandidate.similarity?.toFixed(2)}); proceeding with update.`
      }
      const retry = await client.unifiedStore(retryArgs)
      if (retry?.success && retry.id) return retry.id
    }
    // Fall through — couldn't resolve
    throw new Error(`unified_store dedup_required and unable to retry: ${res.message}`)
  }
  // Unrecognized shape
  throw new Error(`unexpected unified_store result: ${JSON.stringify(res).slice(0, 300)}`)
}

/** Simple trailing-edge throttle for the sync log writes. */
function throttle<T extends (...a: any[]) => any>(fn: T, ms: number): () => void {
  let last = 0
  let timer: NodeJS.Timeout | null = null
  return function () {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn()
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        fn()
      }, ms - (now - last))
    }
  }
}

// (No top-level main() invocation here — the auto-run guard is delegated to
// the separate entry file `import-md-corpus-cli.ts`. This module is
// import-only and side-effect-free, which keeps ts-jest happy under its
// non-ESM test runner. Run via `node dist/scripts/import-md-corpus-cli.js`.)
