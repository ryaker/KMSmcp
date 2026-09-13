/**
 * Ontology entity index for the SparrowDB graph backend.
 *
 * Why this module exists
 * ----------------------
 * `SparrowDBStorage.search()` scored entries from the Knowledge content sidecar and
 * stamped every hit `nodeLabels: ['Knowledge']`. It never looked at a `:Person`,
 * `:Organization`, `:Event` … node, and it never walked a typed edge like `PARENT_OF`.
 * Two consequences, both measured against the live store:
 *
 *   1. "Tell me about my dad" returned technical noise. The Person node
 *      `charles_yaker` (Charles Jack Yaker, `relationship: father`, `PARENT_OF` →
 *      Richard) exists in the graph and was simply unreachable from the read path.
 *   2. `UnifiedSearchTool.expandWithEntityContext` gates on
 *      `nodeLabels ∩ ENTITY_LABELS`, so with every hit hard-coded to `Knowledge` the
 *      `entity_context` block was permanently empty for ontology entities — the
 *      feature had no live input at all.
 *
 * This is deliberately label-agnostic rather than a "dad" special case: the same miss
 * applies to co-founders as `:Person`, companies as `:Organization`, `:Event` nodes,
 * and anything else the ontology holds but the Knowledge sidecar does not mirror.
 *
 * Kept separate from SparrowDBStorage for the same reason as GraphEdgeIndex: that
 * module evaluates `import.meta.url` at the top level, which the CommonJS-mode test
 * runner cannot parse, so nothing importing it is reachable from a test. Everything
 * here takes its graph access by injection and is unit-testable against a fake.
 *
 * What it is NOT
 * --------------
 * Not a second ranker. It emits candidates with an explicit `score` in [0, 1] and the
 * reasons behind it; fusing that with lexical/vector results stays the caller's job
 * (see `UnifiedSearchTool.rankResults`). An entity that matches nothing scores nothing
 * and never enters the pool — which is what keeps a technical query about a "parent
 * commit" from surfacing somebody's father.
 */

/** The subset of the SparrowDB binding this index needs. */
export interface OntologyQueryExecutor {
  execute(cypher: string): { columns: string[]; rows: Array<Record<string, unknown>> }
}

/** One edge as seen from the node it was requested for (mirrors GraphEdgeIndex). */
export interface NeighbourRef {
  relationship: string
  relatedNode: string
  direction: 'outgoing' | 'incoming'
}

/** Adjacency source — `GraphEdgeIndex` satisfies this structurally. */
export interface NeighbourReader {
  relationshipsFor(id: string): NeighbourRef[]
}

/**
 * Node labels that describe a thing in the world rather than a stored note.
 *
 * Single source of truth: `UnifiedSearchTool` imports this rather than keeping its own
 * copy, because the two drifting apart is exactly how `expandWithEntityContext` ends up
 * gating on a label set that no producer emits.
 */
export const ENTITY_LABELS = [
  'Person',
  'Organization',
  'Project',
  'Technology',
  'Concept',
  'Service',
  'Event',
  'Place'
] as const

/** Labels that are system plumbing — indexed nowhere, surfaced as triggers instead. */
export const OPERATIONAL_LABELS = [
  'ContextTrigger',
  'ToolRoute',
  'ResourceMap',
  'QueryType',
  'System',
  'MemoryTier'
] as const

/** Properties that name an entity. Matched against the query; rendered as the headline. */
export const IDENTITY_PROPS = [
  'id', 'name', 'fullName', 'nickname', 'aliases', 'firstName', 'lastName', 'title'
] as const

/**
 * Properties that describe an entity. Rendered into the card and matched as free text.
 *
 * Fixed list rather than "every property on the node": this binding has no
 * Node-reachable way to enumerate a node's properties, so a projection has to name its
 * columns. Unknown property names read back null and are dropped.
 */
export const DETAIL_PROPS = [
  'description', 'summary', 'notes', 'headline', 'purpose', 'role',
  'profession', 'career', 'industry', 'expertise', 'domain', 'status', 'type',
  'relationship', 'relationshipToRich', 'familyTitle', 'sex', 'gender',
  'birthdate', 'born', 'passed', 'died', 'causeOfDeath',
  'location', 'residence', 'city', 'state', 'country',
  'date', 'startDate', 'endDate', 'company', 'organization', 'approach', 'path'
] as const

/** Per-label scan cap. The live store holds low hundreds of entities per label. */
export const MAX_NODES_PER_LABEL = 1000

/** Default number of entity candidates handed back from one search. */
export const DEFAULT_ONTOLOGY_LIMIT = 5

/**
 * Node ids that mean "the user" when a query says "my …".
 *
 * Overridable by `KMS_SELF_ENTITY_ID`; `KMS_DEFAULT_USER_ID` is consulted next, since a
 * personal KMS typically names the self node after the default user. The literal is the
 * last resort and is only ever used when a node with that id actually exists.
 */
export const FALLBACK_SELF_ENTITY_IDS = ['richard_yaker'] as const

/** Tokens too common to carry identity. Deliberately small — this is not a stoplist for prose. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'is', 'it', 'was', 'are',
  'me', 'my', 'our', 'us', 'we', 'i', 'you', 'your', 'who', 'what', 'when', 'where',
  'which', 'about', 'tell', 'show', 'find', 'give', 'know', 'anything', 'something',
  'that', 'this', 'with', 'from', 'has', 'have', 'had', 'did', 'does', 'do', 'be', 'been'
])

/** Score floors. Below these an entity is not a candidate at all. */
export const NAME_SCORE_FLOOR = 0.35
export const TEXT_SCORE_FLOOR = 0.3
/** Free-text property matches can never outrank a name or kinship match. */
export const MAX_TEXT_SCORE = 0.45

// ---------------------------------------------------------------------------
// Kinship
// ---------------------------------------------------------------------------

type Dir = 'incoming' | 'outgoing' | 'any'

interface KinshipStep {
  type: string
  dir: Dir
}

export interface KinshipSpec {
  /** Canonical kinship term, as it would appear in a `relationship` property. */
  cue: string
  /** Every surface form of the cue, including the canonical one. */
  terms: string[]
  /**
   * Weak cues are ambiguous outside a family context — "parent" is a git commit far more
   * often than it is somebody's mother — so they only fire when the query also carries a
   * first-person possessive ("my parents", "our family").
   */
  weak?: boolean
  /** Constrains which of several same-edge relatives the cue means. */
  gender?: 'male' | 'female'
  /**
   * Cues this one subsumes. "my parents" must not reject the node that states
   * `relationship: father` — a father IS a parent, and the contradiction check below
   * would otherwise throw away every relative a broad cue asked for.
   */
  covers?: string[]
  /** Paths from the self node to the relative, walked over the typed edges. */
  paths: KinshipStep[][]
}

const PARENT_IN: KinshipStep = { type: 'PARENT_OF', dir: 'incoming' }
const CHILD_OUT: KinshipStep = { type: 'PARENT_OF', dir: 'outgoing' }
const SIBLING: KinshipStep = { type: 'SIBLING_OF', dir: 'any' }
const SPOUSE: KinshipStep = { type: 'MARRIED_TO', dir: 'any' }
const PARTNER: KinshipStep = { type: 'PARTNER_OF', dir: 'any' }

/**
 * Kinship cues, each mapped to the graph paths that realise it.
 *
 * Cues carry their own canonical term so that a Person node which states its
 * `relationship` outright ("father") is matched without any traversal — the live store's
 * Person nodes do carry that property, and property agreement is stronger evidence than
 * an edge that several relatives share.
 */
export const KINSHIP_SPECS: KinshipSpec[] = [
  { cue: 'father', terms: ['father', 'dad', 'daddy', 'papa', 'pop'], gender: 'male', paths: [[PARENT_IN]] },
  { cue: 'mother', terms: ['mother', 'mom', 'mommy', 'mum', 'mama'], gender: 'female', paths: [[PARENT_IN]] },
  { cue: 'parent', terms: ['parent', 'parents'], weak: true, covers: ['father', 'mother'], paths: [[PARENT_IN]] },
  { cue: 'son', terms: ['son', 'sons'], gender: 'male', paths: [[CHILD_OUT]] },
  { cue: 'daughter', terms: ['daughter', 'daughters'], gender: 'female', paths: [[CHILD_OUT]] },
  { cue: 'child', terms: ['child', 'children', 'kid', 'kids'], weak: true, covers: ['son', 'daughter'], paths: [[CHILD_OUT]] },
  { cue: 'brother', terms: ['brother', 'brothers'], gender: 'male', paths: [[SIBLING]] },
  { cue: 'sister', terms: ['sister', 'sisters'], gender: 'female', paths: [[SIBLING]] },
  { cue: 'sibling', terms: ['sibling', 'siblings'], weak: true, covers: ['brother', 'sister'], paths: [[SIBLING]] },
  { cue: 'wife', terms: ['wife'], gender: 'female', paths: [[SPOUSE], [PARTNER]] },
  { cue: 'husband', terms: ['husband'], gender: 'male', paths: [[SPOUSE], [PARTNER]] },
  { cue: 'spouse', terms: ['spouse', 'partner'], weak: true, covers: ['wife', 'husband'], paths: [[SPOUSE], [PARTNER]] },
  { cue: 'grandfather', terms: ['grandfather', 'grandpa', 'granddad', 'grandad'], gender: 'male', paths: [[PARENT_IN, PARENT_IN]] },
  { cue: 'grandmother', terms: ['grandmother', 'grandma', 'granny', 'nana'], gender: 'female', paths: [[PARENT_IN, PARENT_IN]] },
  { cue: 'grandparent', terms: ['grandparent', 'grandparents'], weak: true, covers: ['grandfather', 'grandmother'], paths: [[PARENT_IN, PARENT_IN]] },
  { cue: 'uncle', terms: ['uncle', 'uncles'], gender: 'male', paths: [[PARENT_IN, SIBLING]] },
  { cue: 'aunt', terms: ['aunt', 'aunts', 'auntie'], gender: 'female', paths: [[PARENT_IN, SIBLING]] },
  { cue: 'nephew', terms: ['nephew', 'nephews'], gender: 'male', paths: [[SIBLING, CHILD_OUT]] },
  { cue: 'niece', terms: ['niece', 'nieces'], gender: 'female', paths: [[SIBLING, CHILD_OUT]] },
  { cue: 'cousin', terms: ['cousin', 'cousins'], paths: [[PARENT_IN, SIBLING, CHILD_OUT]] }
]

/** Every kinship term, for detecting that a node's stated relationship CONTRADICTS a cue. */
const ALL_KINSHIP_TERMS = new Set(KINSHIP_SPECS.flatMap(s => s.terms))

/** Every term a cue accepts, including those of the cues it subsumes. */
function acceptedTerms(spec: KinshipSpec): Set<string> {
  const terms = new Set(spec.terms)
  for (const covered of spec.covers ?? []) {
    const sub = KINSHIP_SPECS.find(s => s.cue === covered)
    for (const t of sub?.terms ?? []) terms.add(t)
  }
  return terms
}

/** First-person possessives that license a weak kinship cue. */
const FIRST_PERSON = /\b(my|our|mine|i|me|we)\b/i

const MALE_VALUES = new Set(['m', 'male', 'man', 'boy', 'he', 'him'])
const FEMALE_VALUES = new Set(['f', 'female', 'woman', 'girl', 'she', 'her'])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OntologyEntity {
  id: string
  /** Real labels, from `labels(n)` where the binding supports it. */
  labels: string[]
  /** Best display name — fullName, else name, else a humanised id. */
  name: string
  /** Every name variant: name, fullName, nickname, aliases, first/last, id segments. */
  nameVariants: string[]
  /** Readable properties, empty values dropped. */
  props: Record<string, string>
  /** Rendered card — what a search caller reads as `content`. */
  content: string
}

export interface OntologyMatch {
  entity: OntologyEntity
  /** Match strength in [0, 1]. Not a relevance score against the whole corpus. */
  score: number
  /** Why it matched, e.g. `kinship:father`, `name`, `date:2023-07-12`. */
  reasons: string[]
}

export interface OntologyIndexOptions {
  labels?: readonly string[]
  /** Adjacency for kinship traversal. Without it, kinship falls back to property matches. */
  edges?: NeighbourReader | null
  /** Explicit self node for "my …" queries. */
  selfId?: string | null
  debug?: (message: string) => void
}

export interface OntologySearchOptions {
  limit?: number
  /** Overrides the configured/derived self node for this call only. */
  selfId?: string | null
}

// ---------------------------------------------------------------------------
// Tokenising / scoring helpers
// ---------------------------------------------------------------------------

/** Lowercase alphanumeric tokens. `charles_yaker` → `['charles','yaker']`. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1)
}

function contentTokens(value: string): string[] {
  return tokenize(value).filter(t => !STOP.has(t))
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * ISO dates named anywhere in a query, however they were written.
 *
 * "what happened July 12 2023" has to reach an Event node whose `date` property reads
 * `2023-07-12`; no amount of token matching gets there, because the query and the stored
 * value share not one token.
 */
export function extractDates(query: string): string[] {
  const found = new Set<string>()
  const lower = query.toLowerCase()
  const monthNames = Object.keys(MONTHS).join('|')

  for (const m of lower.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    found.add(`${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`)
  }
  // "july 12 2023", "july 12th, 2023"
  for (const m of lower.matchAll(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'g'))) {
    found.add(`${m[3]}-${pad(MONTHS[m[1]])}-${pad(Number(m[2]))}`)
  }
  // "12 july 2023"
  for (const m of lower.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames}),?\\s+(\\d{4})\\b`, 'g'))) {
    found.add(`${m[3]}-${pad(MONTHS[m[2]])}-${pad(Number(m[1]))}`)
  }
  // "7/12/2023" — US month/day/year, which is how this corpus was authored.
  for (const m of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    found.add(`${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`)
  }
  return Array.from(found)
}

/**
 * Inverse document frequency over a token vocabulary.
 *
 * A surname shared by six relatives cannot be allowed to count as much as a given name
 * held by one of them, or "Eddie Yaker" matches every Yaker equally well.
 */
function idf(df: number, total: number): number {
  if (df <= 0) return 0
  return Math.log2(1 + total / df)
}

/** The kinship cues a query asks for, weak ones only when first-person context is present. */
export function detectKinshipCues(query: string): KinshipSpec[] {
  const tokens = new Set(tokenize(query))
  const firstPerson = FIRST_PERSON.test(query)
  return KINSHIP_SPECS.filter(spec => {
    if (!spec.terms.some(t => tokens.has(t))) return false
    return spec.weak ? firstPerson : true
  })
}

function genderOf(entity: OntologyEntity): 'male' | 'female' | null {
  for (const key of ['sex', 'gender']) {
    const raw = entity.props[key]
    if (!raw) continue
    const v = raw.trim().toLowerCase()
    if (MALE_VALUES.has(v)) return 'male'
    if (FEMALE_VALUES.has(v)) return 'female'
  }
  return null
}

/** The kinship term an entity states about itself, if any. */
function statedKinship(entity: OntologyEntity): string | null {
  for (const key of ['relationship', 'relationshipToRich', 'familyTitle']) {
    const raw = entity.props[key]
    if (!raw) continue
    const v = raw.trim().toLowerCase()
    if (ALL_KINSHIP_TERMS.has(v)) return v
  }
  return null
}

// ---------------------------------------------------------------------------
// OntologyIndex
// ---------------------------------------------------------------------------

export class OntologyIndex {
  private entities = new Map<string, OntologyEntity>()
  private nameDf = new Map<string, number>()
  private textDf = new Map<string, number>()
  private entityNameTokens = new Map<string, Set<string>>()
  private entityTextTokens = new Map<string, Set<string>>()
  private built = false
  private readonly labels: readonly string[]
  private readonly debug: (message: string) => void
  private edges: NeighbourReader | null
  private configuredSelfId: string | null

  constructor(
    private readonly db: OntologyQueryExecutor,
    options: OntologyIndexOptions = {}
  ) {
    this.labels = options.labels ?? ENTITY_LABELS
    this.edges = options.edges ?? null
    this.configuredSelfId = options.selfId ?? null
    this.debug = options.debug ?? (() => {})
  }

  get isBuilt(): boolean {
    return this.built
  }

  get size(): number {
    return this.entities.size
  }

  /** Late-bind the adjacency source (SparrowDBStorage builds its edge index lazily). */
  setNeighbourReader(reader: NeighbourReader | null): void {
    this.edges = reader
  }

  /** Discard the index; the next read rebuilds it. */
  reset(): void {
    this.entities = new Map()
    this.nameDf = new Map()
    this.textDf = new Map()
    this.entityNameTokens = new Map()
    this.entityTextTokens = new Map()
    this.built = false
  }

  /** Read every ontology node out of the graph. Idempotent — a no-op once built. */
  build(): void {
    if (this.built) return
    // Set built first: a label scan that throws must not make every later search retry
    // the whole scan, and a partially-read index is still better than none.
    this.built = true

    for (const label of this.labels) {
      for (const row of this.readLabelRows(label)) {
        this.ingest(label, row)
      }
    }

    // Document frequencies, computed once over the finished index — a token's weight
    // depends on how many OTHER entities carry it, so it cannot be known during ingest.
    for (const tokens of this.entityNameTokens.values()) {
      for (const t of tokens) this.nameDf.set(t, (this.nameDf.get(t) ?? 0) + 1)
    }
    for (const tokens of this.entityTextTokens.values()) {
      for (const t of tokens) this.textDf.set(t, (this.textDf.get(t) ?? 0) + 1)
    }

    this.debug(`ontology index built: ${this.entities.size} entities across ${this.labels.length} labels`)
  }

  /** One entity by id, or null. */
  get(id: string): OntologyEntity | null {
    this.build()
    return this.entities.get(id) ?? null
  }

  /**
   * The node that "my …" refers to.
   *
   * Explicit configuration wins; then `KMS_DEFAULT_USER_ID` (a personal KMS names the
   * self node after its default user); then the documented fallback, and only when a
   * node with that id is actually present — guessing an id that does not exist would
   * make every kinship query silently resolve against nothing.
   */
  resolveSelfId(env: NodeJS.ProcessEnv = process.env): string | null {
    this.build()
    const candidates = [
      this.configuredSelfId,
      env.KMS_SELF_ENTITY_ID,
      env.KMS_DEFAULT_USER_ID,
      ...FALLBACK_SELF_ENTITY_IDS
    ]
    for (const candidate of candidates) {
      if (candidate && this.entities.has(candidate)) return candidate
    }
    // An explicitly configured self id is honoured even if it is not an indexed entity:
    // the adjacency may know the node when the label scan did not.
    return this.configuredSelfId || env.KMS_SELF_ENTITY_ID || null
  }

  /**
   * Entity candidates for a natural-language query.
   *
   * Three independent signals, strongest wins:
   *   - kinship   ("my dad")            — stated relationship, or a typed path from self
   *   - name      ("Charles Jack Yaker")— idf-weighted overlap with the entity's names
   *   - free text ("Fair Lawn")         — capped, so it can never outrank the other two
   */
  search(query: string, options: OntologySearchOptions = {}): OntologyMatch[] {
    this.build()
    if (this.entities.size === 0) return []

    const limit = options.limit ?? DEFAULT_ONTOLOGY_LIMIT
    const scores = new Map<string, { score: number; reasons: string[] }>()

    const record = (id: string, score: number, reason: string) => {
      if (score <= 0) return
      const existing = scores.get(id)
      if (!existing) {
        scores.set(id, { score, reasons: [reason] })
        return
      }
      existing.reasons.push(reason)
      if (score > existing.score) existing.score = score
    }

    for (const [id, hit] of this.scoreKinship(query, options)) record(id, hit.score, hit.reason)
    for (const [id, hit] of this.scoreNames(query)) record(id, hit.score, hit.reason)
    for (const [id, hit] of this.scoreText(query)) record(id, hit.score, hit.reason)

    return Array.from(scores.entries())
      .map(([id, { score, reasons }]) => ({
        entity: this.entities.get(id)!,
        score: Number(Math.min(1, score).toFixed(4)),
        reasons
      }))
      .filter(m => m.entity)
      .sort((a, b) => (b.score - a.score) || (a.entity.id < b.entity.id ? -1 : 1))
      .slice(0, limit)
  }

  // -------------------------------------------------------------------------
  // Scoring arms
  // -------------------------------------------------------------------------

  private scoreKinship(
    query: string,
    options: OntologySearchOptions
  ): Map<string, { score: number; reason: string }> {
    const out = new Map<string, { score: number; reason: string }>()
    const cues = detectKinshipCues(query)
    if (cues.length === 0) return out

    const selfId = options.selfId !== undefined ? options.selfId : this.resolveSelfId()

    for (const spec of cues) {
      const accepted = acceptedTerms(spec)

      // 1. Relatives reachable from the self node along the cue's typed paths.
      const viaPath = new Map<string, number>()
      if (this.edges && selfId) {
        for (const path of spec.paths) {
          for (const id of this.walk(selfId, path)) {
            if (id === selfId) continue
            const entity = this.entities.get(id)
            if (!entity) continue

            // A relative who says it is the mother is not the father, however the
            // edges read — PARENT_OF alone cannot tell two parents apart.
            const stated = statedKinship(entity)
            if (stated && !accepted.has(stated)) continue
            const gender = genderOf(entity)
            if (spec.gender && gender && gender !== spec.gender) continue

            // A gendered cue satisfied only because nothing contradicted it is weaker
            // than one the node's own gender confirms; a multi-hop path is weaker still.
            const confirmed = !spec.gender || gender === spec.gender
            const score = (confirmed ? 0.9 : 0.6) - (path.length > 1 ? 0.15 : 0)
            const previous = viaPath.get(id)
            if (previous === undefined || previous < score) viaPath.set(id, score)
          }
        }
      }
      for (const [id, score] of viaPath) {
        const previous = out.get(id)
        if (!previous || previous.score < score) {
          out.set(id, { score, reason: `kinship:${spec.cue}:path` })
        }
      }

      // 2. Nodes that state the relationship outright. By this schema's convention a
      //    Person's `relationship` property is its relationship to the self node, so
      //    "father" means Rich's father. Stronger evidence than traversal, because
      //    several relatives share the same edge and only one carries the word — and
      //    strongest of all when the edges agree with the property.
      for (const entity of this.entities.values()) {
        const stated = statedKinship(entity)
        if (!stated || !accepted.has(stated)) continue
        if (entity.id === selfId) continue
        const score = viaPath.has(entity.id) ? 1 : 0.95
        const previous = out.get(entity.id)
        if (!previous || previous.score < score) {
          out.set(entity.id, { score, reason: `kinship:${spec.cue}:stated` })
        }
      }
    }
    return out
  }

  private scoreNames(query: string): Map<string, { score: number; reason: string }> {
    const out = new Map<string, { score: number; reason: string }>()
    const total = this.entities.size
    // Only query tokens that name SOMETHING can be identity evidence; "tell", "about"
    // and the rest fall away for free because no entity carries them as a name token.
    const queryTokens = Array.from(new Set(contentTokens(query))).filter(t => this.nameDf.has(t))
    if (queryTokens.length === 0) return out

    const weightOf = (t: string) => idf(this.nameDf.get(t) ?? 0, total)
    const queryWeight = queryTokens.reduce((sum, t) => sum + weightOf(t), 0)
    if (queryWeight <= 0) return out

    for (const [id, nameTokens] of this.entityNameTokens) {
      let matchedWeight = 0
      for (const t of queryTokens) {
        if (nameTokens.has(t)) matchedWeight += weightOf(t)
      }
      if (matchedWeight <= 0) continue

      let entityWeight = 0
      for (const t of nameTokens) entityWeight += weightOf(t)
      if (entityWeight <= 0) continue

      // Both ways, MULTIPLIED rather than averaged: how much of the query the name
      // accounts for, and how much of the name the query accounts for. Averaging lets a
      // shared surname through — "Yaker" accounts for 100% of the query, so it scored
      // half credit against all six Yakers in the graph and named none of them. A
      // product requires the match to be a good identification in both directions, so
      // "Yaker" alone identifies nobody while "Eddie Yaker" identifies Edward.
      const score = (matchedWeight / queryWeight) * (matchedWeight / entityWeight)
      if (score >= NAME_SCORE_FLOOR) out.set(id, { score, reason: 'name' })
    }
    return out
  }

  private scoreText(query: string): Map<string, { score: number; reason: string }> {
    const out = new Map<string, { score: number; reason: string }>()

    // Dates first: an ISO date in a property is an exact, unambiguous hit that shares no
    // tokens with the way the query wrote it.
    const dates = extractDates(query)
    if (dates.length > 0) {
      for (const entity of this.entities.values()) {
        const hit = dates.find(d => Object.values(entity.props).some(v => v.includes(d)))
        if (hit) out.set(entity.id, { score: 0.9, reason: `date:${hit}` })
      }
    }

    const total = this.entities.size
    const queryTokens = Array.from(new Set(contentTokens(query)))
    if (queryTokens.length === 0) return out

    const weightOf = (t: string) => idf(this.textDf.get(t) ?? 0, total)

    for (const [id, textTokens] of this.entityTextTokens) {
      const matched = queryTokens.filter(t => textTokens.has(t))
      if (matched.length === 0) continue

      // Coverage of the QUERY, not of the entity: a half-matched query is a coincidence
      // ("parent" inside "rebase onto parent commit"), and a fully matched one is a
      // deliberate reference ("Fair Lawn").
      const coverage = matched.length / queryTokens.length
      if (coverage < 0.5) continue
      // A single common word clearing the coverage bar on a one-word query is not
      // evidence; require either a second token or a genuinely rare one.
      const rare = matched.some(t => (this.textDf.get(t) ?? 0) <= Math.max(2, total * 0.02))
      if (matched.length < 2 && !rare) continue

      const weighted = matched.reduce((sum, t) => sum + weightOf(t), 0)
      const queryWeight = queryTokens.reduce((sum, t) => sum + weightOf(t), 0)
      const share = queryWeight > 0 ? weighted / queryWeight : coverage
      const score = MAX_TEXT_SCORE * Math.min(1, coverage * share)
      if (score < TEXT_SCORE_FLOOR) continue

      const previous = out.get(id)
      if (!previous || previous.score < score) out.set(id, { score, reason: 'properties' })
    }
    return out
  }

  /** Node ids reachable from `startId` along an exact typed path. */
  private walk(startId: string, path: KinshipStep[]): Set<string> {
    let frontier = new Set<string>([startId])
    const reader = this.edges
    if (!reader) return new Set()

    for (const step of path) {
      const next = new Set<string>()
      for (const nodeId of frontier) {
        let refs: NeighbourRef[]
        try {
          refs = reader.relationshipsFor(nodeId) ?? []
        } catch (error) {
          this.debug(`kinship walk failed at ${nodeId}: ${error}`)
          continue
        }
        for (const ref of refs) {
          if (ref.relationship !== step.type) continue
          if (step.dir !== 'any' && ref.direction !== step.dir) continue
          if (ref.relatedNode) next.add(ref.relatedNode)
        }
      }
      frontier = next
      if (frontier.size === 0) break
    }
    return frontier
  }

  // -------------------------------------------------------------------------
  // Graph reads
  // -------------------------------------------------------------------------

  /**
   * One label's nodes.
   *
   * `labels(n)` is projected for two reasons. It reports an entity's REAL labels, so a
   * node the scan reached under one label is not mislabelled; and SparrowDB ignores a
   * label predicate naming a label that holds no nodes, so a scan for a label this store
   * has never used would otherwise return every node in the graph. Where the projection
   * is unsupported the scan degrades to the predicate's own label, which is the old
   * behaviour rather than a new failure.
   */
  private readLabelRows(label: string): Array<Record<string, unknown>> {
    const identity = IDENTITY_PROPS.map(p => `n.${p}`).join(', ')
    const detail = DETAIL_PROPS.map(p => `n.${p}`).join(', ')
    const projections = [
      `labels(n), ${identity}, ${detail}`,
      `labels(n), ${identity}`,
      `${identity}, ${detail}`,
      identity
    ]

    for (const projection of projections) {
      try {
        return this.db.execute(
          `MATCH (n:${label}) RETURN ${projection} LIMIT ${MAX_NODES_PER_LABEL}`
        ).rows
      } catch (error) {
        this.debug(`ontology scan of ${label} rejected projection (${projection.slice(0, 40)}…): ${error}`)
      }
    }
    return []
  }

  private ingest(scanLabel: string, row: Record<string, unknown>): void {
    const id = readString(row['n.id'])
    if (!id) return

    const rowLabels = readLabels(row)
    // With labels(n) readable, honour it — and drop a node that the label predicate
    // matched without actually carrying the label.
    if (rowLabels.length > 0 && !rowLabels.includes(scanLabel)) return
    const labels = rowLabels.length > 0 ? rowLabels : [scanLabel]

    const props: Record<string, string> = {}
    for (const key of [...IDENTITY_PROPS, ...DETAIL_PROPS]) {
      if (key === 'id' || key === 'aliases') continue
      const value = readString(row[`n.${key}`])
      if (value) props[key] = value
    }
    const aliases = readList(row['n.aliases'])

    const existing = this.entities.get(id)
    if (existing) {
      // Same node reached under a second label — union rather than overwrite.
      for (const l of labels) if (!existing.labels.includes(l)) existing.labels.push(l)
      for (const [k, v] of Object.entries(props)) if (!existing.props[k]) existing.props[k] = v
      this.finalise(existing, aliases)
      return
    }

    const entity: OntologyEntity = { id, labels, name: '', nameVariants: [], props, content: '' }
    this.entities.set(id, entity)
    this.finalise(entity, aliases)
  }

  /** (Re)derive an entity's display name, name variants, card, and token sets. */
  private finalise(entity: OntologyEntity, aliases: string[]): void {
    const p = entity.props
    const firstLast = [p.firstName, p.lastName].filter(Boolean).join(' ').trim()
    entity.name = p.fullName || p.name || firstLast || p.title || humaniseId(entity.id)

    const variants = new Set<string>()
    for (const v of [p.fullName, p.name, p.nickname, p.firstName, p.lastName, p.title, ...aliases]) {
      if (v) variants.add(v)
    }
    // The id is a name variant too — `charles_yaker` tokenises to the same tokens the
    // name does, and some nodes carry an id and nothing else.
    variants.add(entity.id)
    entity.nameVariants = Array.from(variants)

    entity.content = renderCard(entity, aliases)

    const nameTokens = new Set<string>()
    for (const v of entity.nameVariants) for (const t of tokenize(v)) if (!STOP.has(t)) nameTokens.add(t)
    this.entityNameTokens.set(entity.id, nameTokens)

    const textTokens = new Set<string>()
    for (const t of contentTokens(entity.content)) textTokens.add(t)
    this.entityTextTokens.set(entity.id, textTokens)
  }
}

// ---------------------------------------------------------------------------
// Rendering / decoding
// ---------------------------------------------------------------------------

/** Property order in the rendered card — identity, then the facts that identify a person. */
const CARD_PROP_ORDER = [
  'relationship', 'relationshipToRich', 'familyTitle', 'role', 'title', 'profession',
  'career', 'purpose', 'headline', 'description', 'summary', 'notes',
  'birthdate', 'born', 'passed', 'died', 'causeOfDeath',
  'date', 'startDate', 'endDate',
  'residence', 'location', 'city', 'state', 'country',
  'company', 'organization', 'industry', 'domain', 'expertise', 'approach',
  'status', 'type', 'sex', 'gender', 'path'
]

/**
 * A readable card for an ontology node.
 *
 * The card is what a search caller sees as `content`, so it has to read as prose rather
 * than as a property dump — an agent quoting "Charles Jack Yaker (Charlie) — Person"
 * back to a user is the whole point of surfacing the node.
 */
export function renderCard(entity: OntologyEntity, aliases: string[] = []): string {
  const p = entity.props
  const nickname = p.nickname && p.nickname !== entity.name ? ` (${p.nickname})` : ''
  const label = entity.labels[0] ?? 'Entity'
  const lines = [`${entity.name}${nickname} — ${label}`]

  const alsoKnownAs = aliases.filter(a => a && a !== entity.name && a !== p.nickname)
  if (alsoKnownAs.length > 0) lines.push(`also known as: ${alsoKnownAs.join(', ')}`)

  const seen = new Set<string>()
  for (const key of CARD_PROP_ORDER) {
    const value = p[key]
    if (!value || seen.has(value)) continue
    seen.add(value)
    lines.push(`${key}: ${value}`)
  }
  return lines.join('\n')
}

/** `charles_yaker` → `Charles Yaker`; used only when a node carries no name property. */
function humaniseId(id: string): string {
  return id
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function readString(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}

/** `aliases` is stored as a JSON array string; tolerate a comma-separated string too. */
function readList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(v => readString(v)).filter(Boolean)
  const s = readString(raw)
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    if (Array.isArray(parsed)) return parsed.map(v => readString(v)).filter(Boolean)
  } catch { /* not JSON — fall through */ }
  return s.split(',').map(v => v.trim()).filter(Boolean)
}

/** `labels(n)` comes back as an array, a JSON array string, or not at all. */
function readLabels(row: Record<string, unknown>): string[] {
  for (const key of ['labels(n)', 'labels', 'n.labels']) {
    if (!(key in row)) continue
    const values = readList(row[key])
    if (values.length > 0) return values
  }
  return []
}
