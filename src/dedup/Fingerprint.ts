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

/**
 * Normalize content for fingerprinting. Two strings that differ only in
 * whitespace produce the same fingerprint.
 *
 * Rules:
 *   - Strip trailing whitespace from each line
 *   - Collapse runs of horizontal whitespace WITHIN a line to a single space
 *   - Normalize line endings (CRLF / CR → LF)
 *   - Strip leading/trailing blank lines from the whole content
 *
 * We deliberately preserve internal blank lines (between paragraphs) so
 * structurally distinct content stays distinct after normalization.
 */
export function normalize(content: string): string {
  if (typeof content !== 'string') return ''
  // Normalize line endings first so per-line operations work uniformly.
  const unifiedNewlines = content.replace(/\r\n?/g, '\n')
  const lines = unifiedNewlines.split('\n').map(line => {
    // Collapse runs of horizontal whitespace (spaces, tabs) within the line
    // to a single space. \s would also match newlines — we explicitly use
    // [ \t\f\v ] so paragraph structure (newlines) is preserved.
    const collapsed = line.replace(/[ \t\f\v ]+/g, ' ')
    // Strip leading + trailing whitespace per-line (line-internal already
    // collapsed; this drops the leading/trailing single-space residue).
    return collapsed.trim()
  })
  // Drop leading + trailing blank lines so wrapping noise doesn't fork the
  // fingerprint. Internal blank lines preserved (paragraph structure).
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
