/**
 * Compound-token expansion for lexical search.
 *
 * Identifiers such as `mem0ParentId`, `dedup_unchecked`, `kms-context-inject` are one
 * token to a whitespace tokenizer, so they never match a natural-language query like
 * "mem0 parent id" or "dedup unchecked" under word-boundary or substring matching:
 *   - camelCase/PascalCase has no non-alphanumeric separator at all, so lowercasing
 *     "mem0ParentId" to "mem0parentid" leaves one contiguous word.
 *   - snake_case doesn't help either — `_` is a JS regex word character, so `\bparent\b`
 *     finds no boundary inside "dedup_unchecked".
 *
 * This module splits a token on those boundaries (camelCase/PascalCase transitions,
 * `.`/`_`/`-`/whitespace delimiters, and letter/digit transitions) and returns every
 * intermediate form — the original token, each delimiter-level segment, and each fully
 * atomic part — lowercased and deduplicated. Callers use this to let a compound token on
 * either side of a lexical match (query or content) be seen as its parts, not just as
 * one opaque string.
 *
 * Pure and side-effect free: no I/O, no shared state, safe to call per-candidate in a
 * ranking hot path.
 */

/** `.`/`_`/`-`/whitespace — the delimiters a compound identifier is built from. */
const DELIMITER_RE = /[._\-\s]+/

/** Zero-width marker used internally to mark a split point before delimiter splitting. */
const BOUNDARY = '\u0000'

/**
 * Split a single delimiter-free segment on camelCase/PascalCase and letter/digit
 * transitions. "mem0ParentId" -> ["mem", "0", "Parent", "Id"]; "HTTPServer" ->
 * ["HTTP", "Server"]; "v3" -> ["v", "3"]. Case is untouched here — callers lowercase.
 */
function splitCamelAndDigits(segment: string): string[] {
  if (!segment) return []
  const marked = segment
    .replace(/([a-z])([A-Z])/g, `$1${BOUNDARY}$2`) // fooBar -> foo|Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, `$1${BOUNDARY}$2`) // HTTPServer -> HTTP|Server
    .replace(/([a-zA-Z])([0-9])/g, `$1${BOUNDARY}$2`) // mem0 -> mem|0
    .replace(/([0-9])([a-zA-Z])/g, `$1${BOUNDARY}$2`) // 0Parent -> 0|Parent
  return marked.split(BOUNDARY).filter(Boolean)
}

/**
 * Expand one raw token into its original form plus every split part, lowercased and
 * deduplicated. Order: original token first, then `.`/`_`/`-` delimiter segments, then
 * atomic (camelCase + digit-boundary) parts within each segment.
 *
 * A token with no compound structure ("timeout") returns exactly `[token.toLowerCase()]`
 * — the length-1 result is what callers use to decide "nothing to expand" and skip any
 * extra work.
 */
export function expandCompoundToken(token: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (t: string): void => {
    const lower = t.toLowerCase()
    if (lower && !seen.has(lower)) {
      seen.add(lower)
      out.push(lower)
    }
  }

  if (!token) return out
  push(token)

  const segments = token.split(DELIMITER_RE).filter(Boolean)
  for (const segment of segments) {
    push(segment)
    for (const atomic of splitCamelAndDigits(segment)) {
      push(atomic)
    }
  }

  return out
}

/** True if `token` has real compound structure — `expandCompoundToken` finds more than
 *  just the token itself. Cheap guard callers use to skip work on plain words. */
export function isCompoundToken(token: string): boolean {
  return expandCompoundToken(token).length > 1
}

/** Separators allowed between the parts of a compound term when matching it in text. */
const PART_SEPARATOR = '[\\s_.\\-]*'

function escapeRegexSource(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The ordered atomic parts of a term: "mem0ParentId" -> ["mem", "0", "parent", "id"]. */
function atomicParts(term: string): string[] {
  return term
    .split(DELIMITER_RE)
    .filter(Boolean)
    .flatMap(splitCamelAndDigits)
    .map((p) => p.toLowerCase())
}

/**
 * Regex source matching a compound term's parts IN ORDER, with optional separators
 * between them, so "mem0ParentId" matches "mem0 parent id", "mem0_parent_id" and
 * "mem0ParentId" alike. Null for a non-compound term. Matching all parts in sequence,
 * rather than any single part, keeps "OneCLI" from matching every text containing
 * "one" and "mem0" from matching every text containing "memory".
 */
export function compoundSequencePattern(term: string): string | null {
  const parts = atomicParts(term)
  if (parts.length < 2) return null
  return parts.map(escapeRegexSource).join(PART_SEPARATOR)
}

/**
 * True if `textLower` contains `term` as a substring, or contains the term's
 * compound parts in sequence (see `compoundSequencePattern`).
 */
export function textIncludesTermOrParts(
  textLower: string,
  term: string,
): boolean {
  if (!term) return false
  if (textLower.includes(term.toLowerCase())) return true
  const pattern = compoundSequencePattern(term)
  return pattern !== null && new RegExp(pattern).test(textLower)
}

/**
 * Regex sources for a Mongo `$or` keyword filter: each keyword escaped, plus the
 * sequence pattern of each compound keyword, capped at `maxTotal` entries.
 */
export function keywordRegexSources(
  keywords: readonly string[],
  maxTotal: number,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (src: string): void => {
    if (out.length < maxTotal && !seen.has(src)) {
      seen.add(src)
      out.push(src)
    }
  }
  for (const k of keywords) push(escapeRegexSource(k.toLowerCase()))
  for (const k of keywords) {
    const pattern = compoundSequencePattern(k)
    if (pattern) push(pattern)
  }
  return out
}
