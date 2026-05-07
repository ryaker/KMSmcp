/**
 * Granola → KMS distillation prompt and types.
 *
 * The Haiku 4.5 (claude-haiku-4-5) call must return a JSON object matching
 * `DistilledMeeting`. The prompt enforces:
 *   - One ~200-word `summary` (the whole-meeting entry's content)
 *   - 2–5 `claims`, each a self-contained typed thought (OB1 6-type taxonomy)
 *   - The OB1 "curate, don't dump" principle: each claim must stand alone
 *     without the original transcript context.
 *
 * Kept as a separate module so it can be unit-tested without a network call,
 * and so the prompt text can be reviewed/diffed independently of the importer
 * driver.
 */

/**
 * OB1 6-type taxonomy. The mapping to KMSmcp's contentType enum
 * (memory|insight|fact|procedure|pattern|relationship) lives in
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
export type DistilledConfidence = 'firm' | 'tentative' | 'exploring'

export interface DistilledClaim {
  /** OB1 type. Maps to KMSmcp contentType; see `mapClaimTypeToContentType`. */
  type: Ob1ClaimType
  /** Self-contained, ~1–3 sentence statement. Must make sense in isolation. */
  content: string
  /** firm | tentative | exploring. */
  confidence: DistilledConfidence
  /** Free-form topic tags (e.g. ["KMSmcp", "dedup-gate"]). */
  topics: string[]
  /** Names of people referenced (e.g. ["Rich", "Kathy"]). Empty if none. */
  people: string[]
}

export interface DistilledMeeting {
  /** ~200-word whole-meeting summary used as the Granola.<title> entry body. */
  summary: string
  /** 2–5 self-contained typed thoughts. */
  claims: DistilledClaim[]
}

/**
 * Map OB1 claim types to KMSmcp contentTypes.
 *
 * decision / brainstorm → 'insight' (creative/decisional thinking)
 * preference            → 'memory'  (Mem0-shaped personal pattern)
 * learning              → 'fact'    (verified knowledge)
 * context               → 'memory'  (situational/episodic)
 * reference             → 'procedure' (pointers to external how-to)
 *
 * If the OB1 type is unrecognized (forward-compatibility), default to 'memory'.
 */
export function mapClaimTypeToContentType(
  ob1Type: Ob1ClaimType | string
): 'memory' | 'insight' | 'fact' | 'procedure' | 'pattern' | 'relationship' {
  switch (ob1Type) {
    case 'decision':
    case 'brainstorm':
      return 'insight'
    case 'preference':
    case 'context':
      return 'memory'
    case 'learning':
      return 'fact'
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
 * prompt is just the meeting metadata + transcript.
 */
export function buildDistillPrompt(meeting: {
  title: string
  meetingId: string
  date?: string
  transcript: string
}): { system: string; user: string } {
  const system = `You distill meeting transcripts into structured JSON for a personal knowledge management system.

Return ONLY a JSON object matching this shape (no prose, no code fences):

{
  "summary": string,        // ~200 words. Whole-meeting summary. NOT the raw transcript. Include who, what, why.
  "claims": [
    {
      "type": "decision" | "preference" | "learning" | "context" | "brainstorm" | "reference",
      "content": string,    // 1-3 self-contained sentences.
      "confidence": "firm" | "tentative" | "exploring",
      "topics": string[],   // short topic tags
      "people": string[]    // people mentioned by name
    }
  ]
}

Rules:
1. Produce 2 to 5 claims. Fewer is fine if the meeting was thin; never produce more than 5.
2. Each claim must be a self-contained statement that makes sense without the original transcript context.
3. Curate, don't dump. Skip pleasantries, scheduling chatter, and content that won't matter in 6 months.
4. Use "decision" for committed choices, "preference" for stated likes/dislikes/ways-of-working, "learning" for new factual knowledge, "context" for situational background that informs future decisions, "brainstorm" for ideas not yet committed, "reference" for pointers to external resources/how-to.
5. "confidence" reflects how firm the speaker(s) sounded: "firm" = decided/known, "tentative" = leaning toward, "exploring" = still mulling.
6. Output MUST be valid JSON. No markdown. No commentary. No trailing text.`

  const dateLine = meeting.date ? `\nDate: ${meeting.date}` : ''
  const user = `Meeting title: ${meeting.title}
Meeting ID: ${meeting.meetingId}${dateLine}

Transcript:
${meeting.transcript}`

  return { system, user }
}

/**
 * Parse and validate a Haiku response. Throws on malformed JSON or schema
 * violations (so the importer driver can log + skip the meeting cleanly).
 *
 * Strips common LLM artifacts: ```json fences, leading/trailing prose, BOM.
 */
export function parseDistilledResponse(raw: string): DistilledMeeting {
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
    // Soft-cap: keep first 5 rather than fail the whole meeting.
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
  const validConfidence: DistilledConfidence[] = ['firm', 'tentative', 'exploring']

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
    if (!validConfidence.includes(c.confidence)) {
      throw new Error(`Claim ${i} has invalid confidence: ${c.confidence}`)
    }
    return {
      type: c.type,
      content: c.content.trim(),
      confidence: c.confidence,
      topics: Array.isArray(c.topics) ? c.topics.filter((t: any) => typeof t === 'string') : [],
      people: Array.isArray(c.people) ? c.people.filter((p: any) => typeof p === 'string') : []
    }
  })

  return {
    summary: parsed.summary.trim(),
    claims
  }
}
