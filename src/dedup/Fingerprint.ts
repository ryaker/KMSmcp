/**
 * Tier 0 fingerprint dedup (issue: DG-T0).
 *
 * Computes a deterministic SHA-256 fingerprint over the tuple
 *   (normalized_content, userId, contentType, subject ?? '')
 *
 * Used by the dedup gate as a CHEAP prepend layer that runs BEFORE the
 * Tier 1 vector similarity check in `unified_store`. Two writes that produce
 * the same fingerprint are guaranteed-identical at the content/scope level
 * (modulo benign whitespace differences) — no embedder, no cosine math,
 * no LLM judge needed.
 *
 * Why Tier 0 helps even with HNSW populated:
 *   1. **Whitespace-equivalent inputs.** Two writes that differ only in
 *      trailing spaces or line-ending style hash to different bytes BUT
 *      are equivalent content. The embedder will score them very high
 *      (often >0.99) but not always above the 0.88 refuse threshold —
 *      especially for very short content where each token weighs heavily.
 *      Tier 0's normalize() collapses these to the same fingerprint.
 *   2. **Latency short-circuit.** A fingerprint check is an O(n) scan of
 *      the in-memory sidecar (~1200 entries → ~0.1 ms). The Tier 1 path
 *      is HNSW search (1-3 ms) + JS post-filter + (sometimes) Anthropic
 *      Haiku 4.5 round-trip (5 s timeout). Tier 0 catches the easy cases
 *      for free.
 *   3. **Exact-match certainty.** When the LLM judge or the embedder is
 *      down (Ollama unreachable, ANTHROPIC_API_KEY unset), Tier 0 still
 *      catches identical re-stores. Useful for batch importers and the
 *      "user accidentally hit submit twice" case.
 *
 * The fingerprint is stored in `metadata.fingerprint` on the new entry so
 * subsequent Tier 0 lookups can match against it directly.
 */

import crypto from 'crypto'

// Horizontal whitespace character class — used by normalize() to identify
// non-newline whitespace. Enumerates space, tab, form-feed, vertical-tab,
// and U+00A0 non-breaking space. NBSP is included because it commonly
// appears in copy-pasted content from rich-text sources (Word, Google
// Docs) and would otherwise fork the fingerprint vs the plain-space
// version of the same content. Newlines are deliberately excluded so
// paragraph structure is preserved at the higher level.
const HWS_CHAR = /[ \t\f\v ]/
const HWS_RUN_GLOBAL = /[ \t\f\v ]+/g
const HWS_TRAILING = /[ \t\f\v ]+$/

/**
 * Normalize content for fingerprinting. Two strings that differ only in
 * trailing whitespace, internal whitespace runs, or line-ending style
 * produce the same fingerprint.
 *
 * Rules:
 *   - Normalize line endings (CRLF / CR → LF)
 *   - Strip TRAILING horizontal whitespace from each line
 *   - Collapse runs of horizontal whitespace WITHIN a line to a single space
 *     (but preserve a single leading-indent block intact)
 *   - Strip leading/trailing blank lines from the whole content
 *
 * Why leading indentation is preserved: indentation is semantically
 * meaningful in code blocks, nested lists, and structured prose. Collapsing
 * `"    code()"` and `"code()"` to the same fingerprint would let Tier 0
 * declare two non-equivalent entries identical. We collapse internal runs
 * (so `"foo    bar"` and `"foo bar"` match) but keep the first leading-
 * whitespace block of each line verbatim.
 *
 * We deliberately preserve internal blank lines (between paragraphs) so
 * structurally distinct content stays distinct after normalization.
 */
export function normalize(content: string): string {
  if (typeof content !== 'string') return ''
  // Normalize line endings first so per-line operations work uniformly.
  const unifiedNewlines = content.replace(/\r\n?/g, '\n')

  const lines = unifiedNewlines.split('\n').map(line => {
    // 1) Capture leading indentation (the contiguous block of horizontal
    //    whitespace at the start of the line). Preserved verbatim —
    //    collapsing it would erase code/list semantics.
    let leadingEnd = 0
    while (leadingEnd < line.length && HWS_CHAR.test(line.charAt(leadingEnd))) {
      leadingEnd++
    }
    const leading = line.slice(0, leadingEnd)
    const rest = line.slice(leadingEnd)

    // 2) Collapse internal whitespace runs in the rest of the line.
    const collapsedRest = rest.replace(HWS_RUN_GLOBAL, ' ')

    // 3) Strip trailing horizontal whitespace only — leading indent kept.
    return (leading + collapsedRest).replace(HWS_TRAILING, '')
  })

  // Drop leading + trailing fully-blank lines so wrapping noise doesn't
  // fork the fingerprint. (After the per-line trailing strip, lines that
  // were pure-whitespace have become empty strings and qualify as blank.)
  let start = 0
  let end = lines.length
  while (start < end && lines[start] === '') start++
  while (end > start && lines[end - 1] === '') end--
  return lines.slice(start, end).join('\n')
}

/**
 * Compute the Tier 0 fingerprint over a write's identifying tuple.
 *
 * Subject defaults to empty string when absent — Tier 0 deliberately treats
 * "no subject" as a distinct scope from "subject=X". This matches Tier 1's
 * subject scoping behavior (see UnifiedStoreTool's `findSimilar` call: when
 * no subject is provided, the gate falls back to userId + contentType only).
 */
export function computeFingerprint(args: {
  content: string
  userId: string
  contentType: string
  subject?: string
}): string {
  const tuple = [
    normalize(args.content),
    args.userId,
    args.contentType,
    args.subject ?? ''
  ]
  // JSON.stringify gives us a canonical, unambiguous separator-free encoding.
  // Two arrays with the same elements always produce the same JSON.
  const payload = JSON.stringify(tuple)
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}
