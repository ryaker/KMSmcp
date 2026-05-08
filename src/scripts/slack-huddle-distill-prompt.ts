/**
 * Slack Huddle → KMS distillation prompt and types.
 *
 * The Haiku 4.5 (claude-haiku-4-5-20251001) call must return a JSON object
 * matching `DistilledHuddle`. The prompt enforces:
 *   - One ~150–300 word `summary` (the whole-huddle entry's content)
 *   - 2–5 `claims`, each a self-contained typed thought (OB1 6-type taxonomy)
 *   - The OB1 "curate, don't dump" principle: each claim must stand alone
 *     without the original canvas context.
 *
 * Kept as a separate module so the prompt + JSON validation logic is
 * unit-testable without a network call, and so the prompt text can be
 * reviewed/diffed independently of the importer driver.
 *
 * Field names mirror PR #75's md-corpus importer (`qualitative_confidence`)
 * for cross-importer consistency.
 */

/**
 * OB1 6-type taxonomy. Maps to KMSmcp contentType
 * (memory|insight|fact|procedure|pattern|relationship) via
 * `mapClaimTypeToContentType` below.
 */
export type Ob1ClaimType =
  | 'decision'
  | 'preference'
  | 'learning'
  | 'context'
  | 'brainstorm'
  | 'reference'

/** Distillation confidence — separate from the numeric KMS confidence field. */
export type QualitativeConfidence = 'firm' | 'tentative' | 'exploring'

export interface DistilledClaim {
  /** OB1 type. Maps to KMSmcp contentType. */
  type: Ob1ClaimType
  /** Self-contained, ~1–3 sentence statement. Must make sense in isolation. */
  content: string
  /** firm | tentative | exploring. */
  qualitative_confidence: QualitativeConfidence
  /** Free-form topic tags (e.g. ["Tengo", "team-norms"]). */
  topics: string[]
  /** Names of people referenced (e.g. ["Rich", "Kathy"]). Empty if none. */
  people: string[]
}

export interface DistilledHuddle {
  /** ~150–300 word whole-huddle summary used as the huddle entry body. */
  summary: string
  /** 2–5 self-contained typed thoughts. */
  claims: DistilledClaim[]
}

/**
 * Map OB1 claim types to KMSmcp contentTypes.
 *
 * decision / brainstorm / learning → 'insight'
 * preference / context             → 'memory'
 * reference                        → 'procedure'
 *
 * If the OB1 type is unrecognized (forward-compatibility), default to 'memory'.
 *
 * Note: this matches PR #75 (md-corpus) where `learning → insight`,
 * which differs from PR #74's Granola mapping (`learning → fact`).
 * Slack huddles are conversational/decisional artifacts more akin to
 * curated documents than to passive observation, so PR #75's mapping fits.
 */
export function mapClaimTypeToContentType(
  ob1Type: Ob1ClaimType | string
): 'memory' | 'insight' | 'fact' | 'procedure' | 'pattern' | 'relationship' {
  switch (ob1Type) {
    case 'decision':
    case 'brainstorm':
    case 'learning':
      return 'insight'
    case 'preference':
    case 'context':
      return 'memory'
    case 'reference':
      return 'procedure'
    default:
      return 'memory'
  }
}

/**
 * Build the distillation system + user prompt pair.
 *
 * The system prompt locks the schema and the curate-don't-dump rule. The user
 * prompt carries the huddle metadata + canvas markdown.
 */
export function buildDistillPrompt(huddle: {
  channelName: string
  huddleDate?: string
  canvasMarkdown: string
  workspace?: string
}): { system: string; user: string } {
  const system = `You distill Slack huddle AI-notes into structured JSON for a personal knowledge management system.

A Slack huddle is a real-time voice/video meeting; the input below is the AI-generated canvas notes, NOT a verbatim transcript. Treat decisions and stated preferences as deliberate.

Return ONLY a JSON object matching this shape (no prose, no code fences):

{
  "summary": string,                  // 150-300 words. Whole-huddle summary. Self-contained — readable without the canvas. Include who, what, why.
  "claims": [
    {
      "type": "decision" | "preference" | "learning" | "context" | "brainstorm" | "reference",
      "content": string,              // 1-3 self-contained sentences. Must make sense WITHOUT the canvas.
      "qualitative_confidence": "firm" | "tentative" | "exploring",
      "topics": string[],             // short topic tags
      "people": string[]              // people mentioned by name
    }
  ]
}

Rules:
1. Produce 2 to 5 claims. Fewer is fine if the huddle was thin; never produce more than 5.
2. Each claim must be a self-contained statement that makes sense without the original canvas context.
3. Curate, don't dump. Skip pleasantries, scheduling chatter, and content that won't matter in 6 months.
4. Use "decision" for committed choices, "preference" for stated likes/dislikes/ways-of-working, "learning" for new factual knowledge surfaced in the huddle, "context" for situational background that informs future decisions, "brainstorm" for ideas not yet committed, "reference" for pointers to external resources/how-to.
5. "qualitative_confidence" reflects how firm the speaker(s) sounded: "firm" = decided/known, "tentative" = leaning toward, "exploring" = still mulling.
6. Output MUST be valid JSON. No markdown. No commentary. No trailing text.`

  const dateLine = huddle.huddleDate ? `\nHuddle date: ${huddle.huddleDate}` : ''
  const wsLine = huddle.workspace ? `\nWorkspace: ${huddle.workspace}` : ''
  const user = `Slack channel: #${huddle.channelName}${wsLine}${dateLine}

Canvas (AI huddle notes, markdown):
${huddle.canvasMarkdown}`

  return { system, user }
}

/**
 * Parse and validate a Haiku response. Throws on malformed JSON or schema
 * violations (so the importer driver can log + skip the huddle cleanly).
 *
 * Strips common LLM artifacts: ```json fences, leading/trailing prose, BOM.
 */
export function parseDistilledResponse(raw: string): DistilledHuddle {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('Empty distillation response')
  }

  // Strip BOM
  let text = raw.replace(/^﻿/, '').trim()

  // Strip ```json ... ``` fences if Haiku wrapped them despite instructions
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  // If there's leading prose, try to find the first { and last }
  if (!text.startsWith('{')) {
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first >= 0 && last > first) {
      text = text.slice(first, last + 1)
    }
  }

  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(
      `Distillation response is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Distillation response is not an object')
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    throw new Error('Distillation response missing string `summary`')
  }
  if (!Array.isArray(parsed.claims)) {
    throw new Error('Distillation response missing `claims` array')
  }
  if (parsed.claims.length === 0) {
    throw new Error('Distillation response has zero claims (need 2–5)')
  }
  if (parsed.claims.length > 5) {
    // Soft-cap: keep first 5 rather than fail the whole huddle.
    parsed.claims = parsed.claims.slice(0, 5)
  }

  const validTypes: Ob1ClaimType[] = [
    'decision',
    'preference',
    'learning',
    'context',
    'brainstorm',
    'reference'
  ]
  const validConfidence: QualitativeConfidence[] = ['firm', 'tentative', 'exploring']

  const claims: DistilledClaim[] = parsed.claims.map((c: any, i: number) => {
    if (!c || typeof c !== 'object') {
      throw new Error(`Claim ${i} is not an object`)
    }
    if (!validTypes.includes(c.type)) {
      throw new Error(`Claim ${i} has invalid type: ${c.type}`)
    }
    if (typeof c.content !== 'string' || c.content.trim().length === 0) {
      throw new Error(`Claim ${i} has empty content`)
    }
    if (!validConfidence.includes(c.qualitative_confidence)) {
      throw new Error(`Claim ${i} has invalid qualitative_confidence: ${c.qualitative_confidence}`)
    }
    return {
      type: c.type,
      content: c.content.trim(),
      qualitative_confidence: c.qualitative_confidence,
      topics: Array.isArray(c.topics) ? c.topics.filter((t: any) => typeof t === 'string') : [],
      people: Array.isArray(c.people) ? c.people.filter((p: any) => typeof p === 'string') : []
    }
  })

  return {
    summary: parsed.summary.trim(),
    claims
  }
}

/**
 * Slack canvas-id extractor.
 *
 * Slackbot huddle recap message body looks like:
 *   "AI huddle notes are ready. Edit, share, ... :chipmunk:
 *    <https://projcaribou.slack.com/docs/T0123ABCD/F4567WXYZ|View AI Notes>"
 *
 * The link form is Slack's `<url|label>` mrkdwn. The canvas file ID is the
 * second path segment under /docs/. The first is the team_id.
 *
 * Returns `{ teamId, fileId }` or `null` if no match.
 */
export function extractCanvasId(
  messageText: string
): { teamId: string; fileId: string } | null {
  if (typeof messageText !== 'string' || messageText.length === 0) return null
  // Match the docs/<team_id>/<file_id> path. Tolerate either a bare URL or
  // mrkdwn `<url|label>` wrapping. Team IDs and file IDs in Slack are
  // alphanumeric and start with T / F respectively, but we accept any
  // [A-Z0-9]+ to stay forward-compatible.
  const re = /slack\.com\/docs\/([a-zA-Z0-9]+)\/([a-zA-Z0-9]+)/i
  const m = messageText.match(re)
  if (!m) return null
  return { teamId: m[1], fileId: m[2] }
}

/**
 * Slackbot recap detector.
 *
 * The recap message:
 *   - Comes from user "USLACKBOT" (the canonical Slackbot user id).
 *   - Body starts with the canonical phrase "AI huddle notes are ready".
 *
 * We accept either by-id ("USLACKBOT") or by-name ("Slackbot") because
 * the search-results JSON shape can vary by client.
 */
export function isSlackbotHuddleRecap(msg: {
  user?: string
  username?: string
  text?: string
}): boolean {
  if (!msg || typeof msg !== 'object') return false
  const text = typeof msg.text === 'string' ? msg.text : ''
  if (!text.toLowerCase().includes('ai huddle notes are ready')) return false
  const userId = typeof msg.user === 'string' ? msg.user.toUpperCase() : ''
  const userName = typeof msg.username === 'string' ? msg.username.toLowerCase() : ''
  return userId === 'USLACKBOT' || userName === 'slackbot'
}
