/**
 * Secret scrubbing for every KMS write path.
 *
 * Every write fans out to Mem0's hosted cloud, so a credential that reaches
 * `unified_store` leaves the machine. Scrubbing masks it before any backend,
 * the embedder, or the dedup gate sees the content: the fact survives, the
 * secret is replaced by `[REDACTED:<type>]`, and only `{type, count}` is
 * recorded — never the value.
 *
 * Patterns are deliberately context-anchored. A bare long hex string is NOT
 * treated as a secret: KMS content is full of git SHAs and SHA-256
 * fingerprints. Hex is only masked where a key name says it is a credential
 * (`token=`, `api_key:`, `Bearer`).
 */

export interface Redaction {
  type: string
  count: number
}

export interface ScrubResult {
  text: string
  redactions: Redaction[]
}

interface Rule {
  type: string
  re: RegExp
  /** Capture groups kept verbatim around the masked value (the key name, quote). */
  keep?: (m: RegExpExecArray) => { before: string; after: string }
}

const mask = (type: string) => `[REDACTED:${type}]`

/** Values that are clearly placeholders, not credentials: `${VAR}`, `<TOKEN>`, `xxxx…`, `...`. */
function isPlaceholder(value: string): boolean {
  return /^[$<{]/.test(value) || /\.\.\./.test(value) || /^(.)\1+$/.test(value) || /x{6,}/i.test(value) ||
    /REDACTED/.test(value)
}

// Order matters: specific vendor formats first, generic key=value last.
const RULES: Rule[] = [
  { type: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai_key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { type: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { type: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { type: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { type: 'doppler_token', re: /\bdp\.(?:st|ct|pt|sa|scim|audit)\.[A-Za-z0-9_.-]{20,}/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    type: 'bearer_token',
    re: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g,
    keep: m => ({ before: m[1], after: '' }),
  },
  {
    type: 'url_credential',
    re: /([?&](?:token|access_token|api_key|apikey|key|secret|sig|signature)=)([^&\s"'`<>]{16,})/gi,
    keep: m => ({ before: m[1], after: '' }),
  },
  {
    // Connection strings with inline credentials: postgres://user:pass@host, mongodb+srv://…
    type: 'url_userinfo',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:)([^\s@/"'`]{4,})(@)/gi,
    keep: m => ({ before: m[1], after: m[3] }),
  },
  {
    // ENV-style assignment: NAME_WITH_KEY/SECRET/TOKEN/PASSWORD = value
    type: 'env_secret',
    re: /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*)(["']?)([^\s"'`]{12,})\2/g,
    keep: m => ({ before: m[1] + m[2], after: m[2] }),
  },
  {
    // JSON/YAML-style: "api_key": "value", password: 'value'
    type: 'keyed_secret',
    re: /(["']?(?:api[_-]?key|secret|token|password|passwd|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*)(["'])([^"'\s]{12,})\2/gi,
    keep: m => ({ before: m[1] + m[2], after: m[2] }),
  },
]

export function scrubSecrets(text: string): ScrubResult {
  if (typeof text !== 'string' || text.length === 0) return { text, redactions: [] }
  const counts = new Map<string, number>()
  let out = text
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    out = out.replace(rule.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray
      // The secret value is the last capture group when a rule keeps context, else the whole match.
      const value = rule.keep ? String(m[m.length - 1]) : String(m[0])
      if (isPlaceholder(value)) return String(m[0])
      counts.set(rule.type, (counts.get(rule.type) ?? 0) + 1)
      if (!rule.keep) return mask(rule.type)
      const { before, after } = rule.keep(m)
      return before + mask(rule.type) + after
    })
  }
  return { text: out, redactions: [...counts].map(([type, count]) => ({ type, count })) }
}

/**
 * Scrub content plus every string in metadata, at any depth (nested objects and
 * arrays). Returns merged redaction counts; callers record them as
 * `metadata.redactions` so a masked entry is auditable without the value.
 */
export function scrubWrite(
  content: string,
  metadata?: Record<string, any> | null
): { content: string; metadata: Record<string, any> | undefined; redactions: Redaction[] } {
  const merged = new Map<string, number>()
  const add = (rs: Redaction[]) => rs.forEach(r => merged.set(r.type, (merged.get(r.type) ?? 0) + r.count))
  const str = (v: string) => { const s = scrubSecrets(v); add(s.redactions); return s.text }

  const walk = (v: any, depth: number): any => {
    if (typeof v === 'string') return str(v)
    if (depth > 8 || v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1))
    // Leave class instances (Date, ObjectId, …) alone; only plain objects are walked.
    if (Object.getPrototypeOf(v) !== Object.prototype) return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]))
  }

  const c = str(content)
  const meta = metadata && typeof metadata === 'object' ? walk(metadata, 0) : (metadata ?? undefined)
  return { content: c, metadata: meta, redactions: [...merged].map(([type, count]) => ({ type, count })) }
}
