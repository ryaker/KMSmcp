/**
 * GranolaCacheV6Source — autonomous source for the Granola → KMS importer.
 *
 * Reads transcripts directly from the Granola desktop app's on-disk cache,
 * bypassing the claude.ai-bound MCP path. This unblocks cron / launchd
 * driven autonomous ingestion (the MCP source requires a live Claude session
 * with the Granola connector, which can't be triggered by a scheduler).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Cache schema (cache-v6.json) — observed 2026-05-07
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Path:  ~/Library/Application Support/Granola/cache-v6.json    (~1.7 MB)
 * Owner: the Granola.app desktop process. The app holds it open and writes
 *        live updates as meetings are recorded. **READ-ONLY from our side.**
 *
 * Top-level shape:
 *   {
 *     "cache": {
 *       "version": 6,
 *       "state": {
 *         "documents":        { <docId>: <Document>, ... },     // 88 entries observed
 *         "transcripts":      { <docId>: <Segment>[], ... },    //  5 entries observed
 *         "meetingsMetadata": { <docId>: <Metadata>, ... },     //  9 entries observed
 *         ...many other Zustand-store fields we don't care about
 *       }
 *     }
 *   }
 *
 * Document (the keys we use; many other fields exist for app state):
 *   {
 *     "id":         "uuid",
 *     "title":      "Project Caribou core team",
 *     "type":       "meeting"  | "scratchpad" | ...,
 *     "created_at": "2026-05-04T16:00:56.892Z",  // ISO
 *     "updated_at": "2026-05-04T16:35:21.047Z",
 *     "deleted_at": null | "2026-..." (soft-delete, skip these),
 *     "valid_meeting": null | true | false,
 *     "transcribe":     true | false | null,
 *     "people":         { creator, attendees, conferencing, url } | null,
 *     "google_calendar_event": { summary, start: { dateTime, timeZone }, end: {...}, ... } | null,
 *     "notes_plain":    "" | "..." (rarely populated; usually empty),
 *     "notes_markdown": "" | "...",
 *     "notes":          { type:"doc", content: ProsemirrorNode[] } (Tiptap doc — usually empty)
 *     ...
 *   }
 *
 * Transcripts (where the actual spoken content lives):
 *   <docId> -> [
 *     {
 *       "id":               "segment-uuid",
 *       "document_id":      <docId>,           // back-pointer
 *       "start_timestamp":  "2026-05-04T16:02:00.964Z",
 *       "end_timestamp":    "2026-05-04T16:02:01.044Z",
 *       "text":             "Speaker turn text...",
 *       "source":           "system" | "microphone",
 *       "is_final":         true,
 *       "transcriber_user_id": null
 *     },
 *     ...  // many segments per meeting (~1000 for an hour-long call)
 *   ]
 *
 * meetingsMetadata (calendar-derived attendee/creator info):
 *   <docId> -> {
 *     "creator":      { name, email, details: { person: { name, employment, ... } } },
 *     "attendees":    [ { email, details: { person: { name: { fullName }, ... }, company } } ],
 *     "conferencing": { type, url, title },
 *     "url":          "https://calendar.google.com/..."
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Important: only ~5/88 documents have transcripts in the local cache
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The Granola app keeps full transcripts only for meetings recorded ON THIS
 * MACHINE in the recent window. Older meetings sync metadata (title, calendar
 * event, attendees) but the transcript array gets evicted. We MUST require
 * a non-empty transcript before emitting a meeting — meetings without a
 * usable transcript are not ingestable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Watermark
 * ─────────────────────────────────────────────────────────────────────────
 *
 * To support incremental cron runs, we persist the highest meeting end-
 * timestamp we've seen at `~/.kms-granola-state.json`:
 *
 *   { "lastSeenEndTs": "2026-05-04T17:00:00.000Z", "lastImportedIds": [...] }
 *
 * On construction, the source reads the file and uses `lastSeenEndTs` as a
 * floor for `since` (caller's `since` still wins if it's later). After
 * `markImported(meetingId, endTs)`, we update the watermark on disk so the
 * next run skips already-emitted meetings.
 *
 * The watermark is ADVISORY — the importer's own sync log
 * (`~/.kms-granola-sync.json`) is the source of truth for whether a meeting
 * was actually written to KMS. The watermark is here so we can early-skip
 * cheap (no need to read 1000-segment transcripts for old meetings) without
 * touching the importer's downstream logic.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ─────────────────────────────────────────────────────────────────────────
// Shape of a meeting as the importer expects it (matches RawMeeting +
// GranolaSource interface in scripts/import-granola.ts).
//
// Defined here as a local interface — not imported from the script — so the
// source can compile under tsc's `rootDir: ./src` without reaching out to
// the scripts/ folder. The scripts/import-granola.ts file structurally
// matches this shape; type compatibility is duck-typed via the `list()`
// signature.
// ─────────────────────────────────────────────────────────────────────────

export interface CacheV6Meeting {
  id: string
  title: string
  date?: string         // ISO start-time of the meeting if known
  transcript: string    // assembled "[Speaker]: text\n[Speaker]: text\n..."
}

/** Narrow structural alias of GranolaSource — kept local to avoid a cross-rootDir import. */
interface GranolaSourceShape {
  list(): Promise<CacheV6Meeting[]>
  markImported?(meetingId: string): void
}

// ─────────────────────────────────────────────────────────────────────────
// Watermark file
// ─────────────────────────────────────────────────────────────────────────

export interface CacheV6Watermark {
  lastSeenEndTs?: string             // ISO; floor for incremental runs
  lastImportedIds: string[]          // tail of recently-imported doc ids (advisory)
}

export const DEFAULT_CACHE_V6_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Granola',
  'cache-v6.json'
)

export const DEFAULT_WATERMARK_PATH = join(homedir(), '.kms-granola-state.json')

export function loadWatermark(path: string): CacheV6Watermark {
  if (!existsSync(path)) return { lastImportedIds: [] }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { lastImportedIds: [] }
    }
    const out: CacheV6Watermark = { lastImportedIds: [] }
    if (typeof parsed.lastSeenEndTs === 'string') out.lastSeenEndTs = parsed.lastSeenEndTs
    if (Array.isArray(parsed.lastImportedIds)) {
      out.lastImportedIds = parsed.lastImportedIds.filter((x: unknown) => typeof x === 'string') as string[]
    }
    return out
  } catch {
    // Malformed watermark = start fresh; the worst case is we re-emit
    // already-imported meetings, which the importer's sync log dedups.
    return { lastImportedIds: [] }
  }
}

export function saveWatermark(path: string, wm: CacheV6Watermark): void {
  // Cap the imported-ids tail at 200 to keep the file small.
  const trimmed: CacheV6Watermark = {
    lastSeenEndTs: wm.lastSeenEndTs,
    lastImportedIds: wm.lastImportedIds.slice(-200)
  }
  writeFileSync(path, JSON.stringify(trimmed, null, 2), 'utf-8')
}

// ─────────────────────────────────────────────────────────────────────────
// Source
// ─────────────────────────────────────────────────────────────────────────

export interface GranolaCacheV6SourceOptions {
  cachePath?: string         // default: DEFAULT_CACHE_V6_PATH
  watermarkPath?: string     // default: DEFAULT_WATERMARK_PATH
  since?: Date               // explicit since-filter; merged with watermark (later one wins)
  ignoreWatermark?: boolean  // for backfills: don't read watermark on construct
}

export class GranolaCacheV6Source implements GranolaSourceShape {
  private cachePath: string
  private watermarkPath: string
  private since: Date | undefined
  private watermark: CacheV6Watermark
  /** Filled in by list(); used by markImported to update the watermark. */
  private lastEndByMeetingId = new Map<string, string>()

  constructor(opts: GranolaCacheV6SourceOptions = {}) {
    this.cachePath = opts.cachePath ?? DEFAULT_CACHE_V6_PATH
    this.watermarkPath = opts.watermarkPath ?? DEFAULT_WATERMARK_PATH
    this.watermark = opts.ignoreWatermark
      ? { lastImportedIds: [] }
      : loadWatermark(this.watermarkPath)

    // Merge: caller's `since` takes precedence ONLY if it's later than the
    // watermark. Otherwise the watermark is the floor (cron resumability).
    const wmSince = this.watermark.lastSeenEndTs
      ? new Date(this.watermark.lastSeenEndTs)
      : undefined
    if (opts.since && (!wmSince || opts.since > wmSince)) {
      this.since = opts.since
    } else if (wmSince) {
      this.since = wmSince
    } else {
      this.since = opts.since
    }
  }

  /**
   * Read the cache, filter to importable meetings, and assemble a transcript
   * string for each. Malformed entries are SKIPPED with a warning, never
   * thrown — Granola is the writer and we don't want a partial write to
   * crash the cron job.
   */
  async list(): Promise<CacheV6Meeting[]> {
    if (!existsSync(this.cachePath)) {
      throw new Error(`Granola cache file not found: ${this.cachePath}`)
    }

    let raw: string
    try {
      raw = readFileSync(this.cachePath, 'utf-8')
    } catch (e) {
      throw new Error(
        `Granola cache file unreadable: ${e instanceof Error ? e.message : e}`
      )
    }

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      // Granola may be mid-write. Don't crash — return empty, retry next run.
      console.warn(
        `⚠️  Granola cache JSON parse failed (likely mid-write): ` +
        `${e instanceof Error ? e.message : e}`
      )
      return []
    }

    const state = parsed?.cache?.state
    if (!state || typeof state !== 'object') {
      console.warn(
        `⚠️  Granola cache missing cache.state — schema may have changed. Skipping.`
      )
      return []
    }

    const documents = state.documents
    const transcripts = state.transcripts
    if (!documents || typeof documents !== 'object') {
      console.warn(`⚠️  Granola cache missing cache.state.documents.`)
      return []
    }
    if (!transcripts || typeof transcripts !== 'object') {
      console.warn(`⚠️  Granola cache missing cache.state.transcripts.`)
      return []
    }

    const out: CacheV6Meeting[] = []
    for (const [docId, doc] of Object.entries(documents) as Array<[string, any]>) {
      try {
        const meeting = this.toMeeting(docId, doc, transcripts[docId])
        if (meeting) {
          out.push(meeting)
        }
      } catch (e) {
        // Per-document defensiveness — one malformed doc shouldn't poison
        // the whole batch.
        console.warn(
          `⚠️  Skipping malformed cache document ${docId}: ` +
          `${e instanceof Error ? e.message : e}`
        )
      }
    }

    // Sort oldest-first so that watermark advance is monotonic across
    // partially-completed runs.
    out.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    return out
  }

  /**
   * Decide whether a document is importable, and assemble its transcript.
   * Returns null when the document should be silently filtered out
   * (deleted, no transcript, before `since`, etc.).
   */
  private toMeeting(
    docId: string,
    doc: any,
    transcriptSegments: any
  ): CacheV6Meeting | null {
    if (!doc || typeof doc !== 'object') return null
    // Soft-deleted documents are not importable.
    if (doc.deleted_at) return null
    // Only the "meeting" document type carries transcripts.
    if (doc.type && doc.type !== 'meeting') return null

    const id = typeof doc.id === 'string' && doc.id.length > 0 ? doc.id : docId
    const title = typeof doc.title === 'string' && doc.title.length > 0
      ? doc.title
      : '(untitled meeting)'

    const startIso = this.extractStartIso(doc)
    const endIso = this.extractEndIso(doc, transcriptSegments)

    // We require the document itself to carry a valid start-time. Without
    // it we can't sort, can't watermark, and can't filter by `since` — the
    // doc is structurally malformed.
    if (!startIso) {
      console.warn(
        `⚠️  Skipping document ${id} (${title}): no valid created_at or ` +
        `google_calendar_event.start.dateTime.`
      )
      return null
    }

    // since-filter: drop meetings whose end-ts is at or before the floor.
    // We use <= rather than < so that the watermark (set to a meeting's
    // own end-ts after marking it imported) excludes that meeting on the
    // next run — otherwise we'd re-emit the most recently imported one.
    if (this.since && endIso) {
      if (new Date(endIso).getTime() <= this.since.getTime()) {
        return null
      }
    }

    // Must have a non-empty transcript array. Meetings whose transcripts
    // have been evicted from cache are not importable from this source.
    if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) {
      return null
    }

    const transcript = assembleTranscript(transcriptSegments)
    if (transcript.length === 0) return null

    if (endIso) this.lastEndByMeetingId.set(id, endIso)

    return {
      id,
      title,
      date: startIso,
      transcript
    }
  }

  private extractStartIso(doc: any): string | undefined {
    // Preferred: calendar event start (real meeting start time).
    const calStart = doc?.google_calendar_event?.start?.dateTime
    if (typeof calStart === 'string' && calStart.length > 0) {
      const d = new Date(calStart)
      if (!isNaN(d.getTime())) return d.toISOString()
    }
    // Fallback: document creation timestamp.
    if (typeof doc.created_at === 'string') {
      const d = new Date(doc.created_at)
      if (!isNaN(d.getTime())) return d.toISOString()
    }
    return undefined
  }

  private extractEndIso(doc: any, segments: any): string | undefined {
    const calEnd = doc?.google_calendar_event?.end?.dateTime
    if (typeof calEnd === 'string' && calEnd.length > 0) {
      const d = new Date(calEnd)
      if (!isNaN(d.getTime())) return d.toISOString()
    }
    // Fallback: last transcript segment end_timestamp (only if present).
    if (Array.isArray(segments) && segments.length > 0) {
      for (let i = segments.length - 1; i >= 0; i--) {
        const ts = segments[i]?.end_timestamp
        if (typeof ts === 'string') {
          const d = new Date(ts)
          if (!isNaN(d.getTime())) return d.toISOString()
        }
      }
    }
    if (typeof doc.updated_at === 'string') {
      const d = new Date(doc.updated_at)
      if (!isNaN(d.getTime())) return d.toISOString()
    }
    return undefined
  }

  /**
   * Persist that we've imported `meetingId`. Advances the watermark to the
   * meeting's end-timestamp so the NEXT call to `new GranolaCacheV6Source()`
   * skips it cheaply.
   *
   * Idempotent. Best-effort: a failure here is logged but does not throw.
   */
  markImported(meetingId: string): void {
    const endIso = this.lastEndByMeetingId.get(meetingId)
    // Append to the imported-ids tail (deduped).
    if (!this.watermark.lastImportedIds.includes(meetingId)) {
      this.watermark.lastImportedIds.push(meetingId)
    }
    // Advance the watermark only forward.
    if (endIso) {
      const cur = this.watermark.lastSeenEndTs ? new Date(this.watermark.lastSeenEndTs) : null
      const next = new Date(endIso)
      if (!cur || next > cur) {
        this.watermark.lastSeenEndTs = next.toISOString()
      }
    }
    try {
      saveWatermark(this.watermarkPath, this.watermark)
    } catch (e) {
      console.warn(
        `⚠️  Failed to persist Granola watermark to ${this.watermarkPath}: ` +
        `${e instanceof Error ? e.message : e}`
      )
    }
  }

  /** Test/inspection helper — current in-memory watermark state. */
  getWatermark(): CacheV6Watermark {
    return { ...this.watermark, lastImportedIds: [...this.watermark.lastImportedIds] }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Transcript assembly
// ─────────────────────────────────────────────────────────────────────────

/**
 * Assemble a Granola transcript array into a single string the distiller
 * can chew on. Format:
 *   [Microphone] line one
 *   [System] line two
 *   ...
 *
 * `source` in the cache is "microphone" (the local user's voice) or
 * "system" (other participants via the system audio loopback). We label
 * each segment so the distiller can attribute claims correctly.
 *
 * Adjacent same-source segments get joined into one line to avoid the
 * one-segment-per-word fragmentation Granola sometimes produces.
 */
export function assembleTranscript(segments: any[]): string {
  if (!Array.isArray(segments) || segments.length === 0) return ''

  const lines: Array<{ source: string; text: string }> = []
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    const text = typeof seg.text === 'string' ? seg.text.trim() : ''
    if (text.length === 0) continue
    // Granola flips between "is_final": true and partial in-progress segments.
    // Skip non-final segments — they're superseded by a later final one.
    if (seg.is_final === false) continue

    const source = labelSource(seg.source)
    const last = lines[lines.length - 1]
    if (last && last.source === source) {
      last.text += ' ' + text
    } else {
      lines.push({ source, text })
    }
  }

  return lines.map(l => `[${l.source}] ${l.text}`).join('\n')
}

function labelSource(source: unknown): string {
  if (source === 'microphone') return 'Microphone'
  if (source === 'system') return 'System'
  if (typeof source === 'string' && source.length > 0) return source
  return 'Unknown'
}
