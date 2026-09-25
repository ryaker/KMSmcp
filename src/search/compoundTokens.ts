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

/**
 * Quick, cheap test for whether `text` contains ANY token that could decompose — a
 * delimiter, a case transition, or a letter/digit transition. Used to skip the (slightly
 * more expensive) per-token scan in `compoundExpansionSuffix` for ordinary prose, which
 * is the overwhelming majority of stored content.
 */
const HAS_COMPOUND_HINT_RE = /[_\-.]|[a-z][A-Z]|[A-Za-z][0-9]|[0-9][A-Za-z]/

/** Tokens made of letters, digits, and the compound delimiters. */
const TOKEN_RE = /[a-zA-Z0-9_.-]+/g

/**
 * Extra sub-tokens to append to `text` so a compound identifier's parts become
 * independently word-boundary-matchable, WITHOUT touching text that has no compound
 * tokens (returns `''`, so plain prose is byte-for-byte unaffected downstream).
 *
 * Only the split PARTS are returned (never the original whole token, which is already
 * present in `text` itself) — appending whole tokens back in would double-count their
 * occurrences for every match, including plain non-compound words, and inflate density
 * scoring across the board rather than only where it's needed.
 */
export function compoundExpansionSuffix(text: string): string {
  if (!text || !HAS_COMPOUND_HINT_RE.test(text)) return ''

  const seen = new Set<string>()
  const extras: string[] = []
  const tokens = text.match(TOKEN_RE) ?? []
  for (const raw of tokens) {
    const parts = expandCompoundToken(raw)
    if (parts.length <= 1) continue // not compound — nothing to add
    const original = raw.toLowerCase()
    for (const part of parts) {
      if (part === original || seen.has(part)) continue
      seen.add(part)
      extras.push(part)
    }
  }
  return extras.length ? ` ${extras.join(' ')}` : ''
}

/**
 * True if `textLower` (already lowercased) contains `term` verbatim, OR contains one of
 * `term`'s compound split parts.
 *
 * `term` must be passed in its ORIGINAL case, not pre-lowercased — camelCase/PascalCase
 * boundaries ("mem0ParentId") only exist before lowercasing, and `expandCompoundToken`
 * needs them to split correctly. The verbatim comparison is still case-insensitive
 * (`term` is lowercased here before either check).
 *
 * For a non-compound term this is exactly `textLower.includes(term.toLowerCase())` —
 * the expansion path only runs when `term` actually decomposes.
 */
export function textIncludesTermOrParts(
  textLower: string,
  term: string,
): boolean {
  if (!term) return false
  const lowerTerm = term.toLowerCase()
  if (textLower.includes(lowerTerm)) return true
  for (const part of expandCompoundToken(term)) {
    if (part !== lowerTerm && part.length > 1 && textLower.includes(part))
      return true
  }
  return false
}

/**
 * Expand a list of already-split query keywords with their compound parts, for a
 * caller (Mongo's `$or` keyword list) that needs a bounded, deduplicated flat list
 * rather than a per-keyword predicate. Original keywords are always kept; expansion
 * parts are appended only while the total stays under `maxTotal`, so a query with many
 * compound terms cannot blow up the number of `$or` clauses.
 */
export function expandKeywordsBounded(
  keywords: readonly string[],
  maxTotal: number,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (k: string): boolean => {
    if (seen.has(k)) return true
    if (out.length >= maxTotal) return false
    seen.add(k)
    out.push(k)
    return true
  }

  // Original keywords first — never dropped for a compound expansion of an earlier one.
  for (const k of keywords) {
    const lower = k.toLowerCase()
    if (!push(lower)) return out
  }
  for (const k of keywords) {
    const lower = k.toLowerCase()
    for (const part of expandCompoundToken(k)) {
      if (part === lower || part.length < 2) continue
      if (!push(part)) return out
    }
  }
  return out
}
