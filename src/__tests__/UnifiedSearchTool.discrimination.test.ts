/**
 * Rank-time discrimination tests for UnifiedSearchTool.
 *
 * Two named causes from the retrieval baseline (mean P@5 = 0.54, P@1 = 0.70 over 20
 * real queries), each pinned here by the exact query that scored 0.0:
 *
 *   CAUSE 1 — no entity / proper-noun weighting. "Joytopia brand colors" returned five
 *   OTHER projects' brand colors; the generic phrase matched everywhere and the one
 *   discriminating proper noun counted for no more than the boilerplate.
 *
 *   CAUSE 2 — near-duplicate entries crowd out substance. "LRI binary parsing format"
 *   returned five near-paraphrases of one governance rule; the single entry describing
 *   the actual binary format was pushed out of the window.
 *
 * Each failing case is set up twice: once through `preFixRank`, an emulation of the
 * ranker as it was (unweighted coverage, no duplicate suppression), to prove the
 * fixture really does reproduce the baseline failure, and once through the real
 * `rankResults`. A fixture that stopped reproducing the bug would make the "after"
 * assertion vacuous, so both halves are asserted.
 *
 * The private members are reached via bracket access rather than being widened to
 * public purely for testability, matching UnifiedSearchTool.ranking.test.ts.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'

const tool = new UnifiedSearchTool({} as any, {} as any)

const rank = (results: any[], query: string) => (tool as any).rankResults(results, query)
const relevance = (content: string, query: string, weights?: Record<string, number>) =>
  (tool as any).calculateRelevance(content, query, weights)
const recency = (ts?: string) => (tool as any).calculateRecency(ts)
const termWeights = (results: any[], query: string) => (tool as any).computeTermWeights(results, query)
const contentTokens = (content: string) => (tool as any).contentTokens(content)
const jaccard = (a: string, b: string) => (tool as any).jaccard(contentTokens(a), contentTokens(b))

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const ids = (results: any[]) => results.map(r => r.id)

/**
 * The ranker as it behaved at the baseline: unweighted lexical coverage, same recency
 * and confidence mix, no near-duplicate pass. Used only to demonstrate that each
 * fixture below genuinely reproduces the measured failure.
 */
const preFixRank = (results: any[], query: string) => results
  .map(r => ({ ...r, _s: relevance(r.content, query) * 0.70 + recency(r.timestamp) * 0.25 + (r.confidence ?? 0) * 0.05 }))
  .sort((a, b) => b._s - a._s)

// ---------------------------------------------------------------------------
// CAUSE 1 fixture — "Joytopia brand colors"
//
// Five short, recent entries about other projects' brand colors, plus the real
// joytopia-brand-identity entry: a full guidelines document, so it is long (length
// damping applies) and it is older. Unweighted, the competitors' 2-of-3 term coverage
// on undamped short text beats the target's 3-of-3 on damped long text — which is
// exactly how five wrong answers filled the window.
// ---------------------------------------------------------------------------
const JOYTOPIA_CANDIDATES = [
  {
    id: 'tengo-portal-frontend',
    timestamp: daysAgo(10),
    confidence: 1,
    content: 'Tengo portal-frontend brand colors: the primary brand color is a deep navy with a secondary amber accent; all brand colors live in the tailwind config under theme extend colors.'
  },
  {
    id: 'blockcopy26-rebrand',
    timestamp: daysAgo(20),
    confidence: 1,
    content: 'BlockCopy26 rebrand shipped new brand colors — deep violet primary, slate neutrals. The old brand colors were retired from the design tokens package.'
  },
  {
    id: 'trading-dashboard-theme',
    timestamp: daysAgo(5),
    confidence: 1,
    content: 'Trading dashboard brand colors follow the terminal palette: green for gains, red for losses, and a muted grey chrome. Brand colors are defined in the theme module.'
  },
  {
    id: 'abundance-coach-site',
    timestamp: daysAgo(30),
    confidence: 1,
    content: 'Abundance Coach marketing site brand colors were refreshed: warm coral CTA against cream. Brand colors and typography are documented in the design system.'
  },
  {
    id: 'sparrowdb-docs-theme',
    timestamp: daysAgo(2),
    confidence: 1,
    content: 'SparrowDB docs site brand colors: monochrome with a single teal accent. No other brand colors are permitted in the docs theme.'
  },
  {
    id: 'joytopia-brand-identity',
    timestamp: daysAgo(150),
    confidence: 1,
    content: 'Joytopia brand identity guidelines. ' +
      'Palette: the primary is a warm teal, the secondary a sunrise gold, with deep indigo for depth and a cream neutral for surfaces. ' +
      'These brand colors carry across MyMoneyCoach, the Sophia character assets, and every piece of Joytopia marketing collateral. ' +
      'Typography: display headings are set in a humanist sans at semibold; body copy is the same family at regular with generous line height. ' +
      'Never letterspace the wordmark and never set the wordmark in all caps. ' +
      'Logo usage: maintain clear space equal to the height of the mark on all four sides. Do not place the mark on a busy photograph, do not recolour it, do not add a drop shadow, and do not rotate it. ' +
      'Voice and tone: warm, plain-spoken, never preachy and never scarcity-driven. Write to someone who is capable but tired. Prefer short sentences. Avoid jargon and avoid exclamation marks. ' +
      'Imagery: Pixar-style 3D renders for character work, natural light photography everywhere else, no stock-photo handshakes and no literal money imagery. ' +
      'Accessibility: every text and background pairing must clear WCAG AA, which rules out the gold on cream combination for body copy. ' +
      'Application: presentation decks, one-page PDFs, social cards and the app shell all draw from the same token set so nothing drifts.'
  },
]

// ---------------------------------------------------------------------------
// CAUSE 2 fixture — "LRI binary parsing format"
//
// Five rewordings of one governance rule, all of which legitimately contain the query
// terms (which is why they ranked), plus unrelated investigation notes and the single
// entry that actually documents the binary format.
// ---------------------------------------------------------------------------
const LRI_CANDIDATES = [
  { id: 'gov-1', timestamp: daysAgo(3), confidence: 1, content: 'LRI binary parsing governance: do not change the binary parsing code under the Phoenix scratch volume without an approved written plan. Parsing work on the LRI format is read-only by default.' },
  { id: 'gov-2', timestamp: daysAgo(6), confidence: 1, content: 'LRI binary parsing governance rule: the binary parsing code under the Phoenix scratch volume must never be changed without an approved written plan; parsing work on the LRI format stays read-only by default.' },
  { id: 'gov-3', timestamp: daysAgo(9), confidence: 1, content: 'Governance for LRI binary parsing: never change parsing code under the Phoenix scratch volume unless a written plan is approved. Work on the LRI binary format is read-only by default.' },
  { id: 'gov-4', timestamp: daysAgo(12), confidence: 1, content: 'LRI parsing process governance: an approved written plan is required before changing the binary parsing code under the Phoenix scratch volume. LRI format parsing work defaults to read-only.' },
  { id: 'gov-5', timestamp: daysAgo(14), confidence: 1, content: 'Rule for LRI binary parsing work: the parsing code under the Phoenix scratch volume is not to be changed until a written plan has been approved, and all LRI format parsing stays read-only by default.' },
  { id: 'note-lldb-bridge', timestamp: daysAgo(4), confidence: 1, content: 'The lri_process bridge is attached with LLDB against libcp.dylib; breakpoints on the ISP entry points survive a re-attach but the symbol table has to be reloaded each time.' },
  { id: 'note-per-camera-isp', timestamp: daysAgo(8), confidence: 1, content: 'Per-camera ISP investigation notes: camera B and camera C share a calibration block, which explains the duplicated gain curves seen in the dump.' },
  { id: 'note-calibration-payload', timestamp: daysAgo(15), confidence: 1, content: 'Parsing the calibration payload requires the little-endian format flag; otherwise the offsets read as garbage.' },
  { id: 'lri-binary-format-spec', timestamp: daysAgo(60), confidence: 1, content: 'LRI binary format specification: the file opens with a 32-byte header whose magic is LRI followed by a null byte, then a table of per-camera blocks. Parsing the LRI binary format means reading the block count at offset 0x10 and walking fixed-size descriptors.' },
]

const isGovernanceVariant = (r: any) => String(r.id).startsWith('gov-')

describe('CAUSE 1 — entity / proper-noun weighting', () => {
  const QUERY = 'Joytopia brand colors'

  it('reproduces the baseline failure without term weighting', () => {
    // Pinning the bug: every one of the top five is some other project's brand colors,
    // and the entry the user asked for does not appear in the window at all. P@5 = 0.0.
    const before = ids(preFixRank(JOYTOPIA_CANDIDATES, QUERY))
    expect(before.slice(0, 5)).not.toContain('joytopia-brand-identity')
    expect(before[5]).toBe('joytopia-brand-identity')
  })

  it('ranks the entry carrying the proper noun first — the baseline failing case', () => {
    const ranked = rank(JOYTOPIA_CANDIDATES, QUERY)
    expect(ranked[0].id).toBe('joytopia-brand-identity')
  })

  it('separates it from the generic matches by a wide margin, not a hair', () => {
    // A one-rank flip that a slightly different fixture would undo is not a fix.
    const ranked = rank(JOYTOPIA_CANDIDATES, QUERY)
    expect(ranked[0]._score).toBeGreaterThan(ranked[1]._score * 1.4)
  })

  it('weights the rare discriminating term far above the ubiquitous ones', () => {
    const weights = termWeights(JOYTOPIA_CANDIDATES, QUERY)
    expect(weights.joytopia).toBeGreaterThan(weights.brand * 10)
    expect(weights.joytopia).toBeGreaterThan(weights.colors * 10)
  })

  it('leaves a term that every candidate shares almost no say in the ranking', () => {
    // "brand" and "colors" are in all six; on their own they must barely move a score.
    const weights = termWeights(JOYTOPIA_CANDIDATES, QUERY)
    const generic = relevance('Some other project brand colors are documented here.', QUERY, weights)
    expect(generic).toBeLessThan(0.15)
  })

  it('normalises weights across the terms so _relevance keeps its [0, 1] meaning', () => {
    const weights = termWeights(JOYTOPIA_CANDIDATES, QUERY)
    const sum = Object.values(weights).reduce((a: number, b: any) => a + b, 0)
    expect(sum).toBeCloseTo(1, 3)
    const ranked = rank(JOYTOPIA_CANDIDATES, QUERY)
    for (const r of ranked) {
      expect(r._relevance).toBeGreaterThanOrEqual(0)
      expect(r._relevance).toBeLessThanOrEqual(1)
    }
  })

  it('gives a term present in no candidate zero weight instead of deflating everyone', () => {
    // A term nobody has cannot discriminate; leaving it in the denominator would scale
    // every score down by the same factor for no ranking benefit.
    const weights = termWeights(JOYTOPIA_CANDIDATES, 'Joytopia brand colors zzzunmatched')
    expect(weights.zzzunmatched).toBe(0)
    const withNoise = rank(JOYTOPIA_CANDIDATES, 'Joytopia brand colors zzzunmatched')
    const without = rank(JOYTOPIA_CANDIDATES, 'Joytopia brand colors')
    expect(withNoise[0].id).toBe(without[0].id)
    expect(withNoise[0]._relevance).toBeCloseTo(without[0]._relevance, 4)
  })

  it('does not weight when there is no candidate set to be rare against', () => {
    // Fewer than two candidates: nothing to discriminate between, so fall back to
    // uniform rather than inventing a spread from a single document.
    expect(termWeights([JOYTOPIA_CANDIDATES[0]], 'Joytopia brand colors')).toEqual({})
    expect(termWeights([], 'Joytopia brand colors')).toEqual({})
  })

  it('is behaviour-identical to the unweighted scorer when no weights are supplied', () => {
    // calculateRelevance must stay usable standalone on one document, and every
    // existing caller and test of the two-argument form must be unaffected.
    const content = 'Ollama classify timeout raised from 3000ms to 8000ms.'
    const query = 'Ollama classify timeout'
    const uniform = { ollama: 1, classify: 1, timeout: 1 }
    expect(relevance(content, query, undefined)).toBe(relevance(content, query))
    expect(relevance(content, query, {})).toBe(relevance(content, query))
    expect(relevance(content, query, uniform)).toBeCloseTo(relevance(content, query), 10)
  })

  it('exposes the new signal the same inspectable way as _score/_relevance/_recency', () => {
    const ranked = rank(JOYTOPIA_CANDIDATES, QUERY)
    for (const r of ranked) {
      expect(r).toHaveProperty('_score')
      expect(r).toHaveProperty('_relevance')
      expect(r).toHaveProperty('_recency')
      expect(r).toHaveProperty('_termWeights')
      expect(r).toHaveProperty('_matchedTerms')
    }
    const target = ranked.find((r: any) => r.id === 'joytopia-brand-identity')
    expect(target._matchedTerms.sort()).toEqual(['brand', 'colors', 'joytopia'])
    const generic = ranked.find((r: any) => r.id === 'sparrowdb-docs-theme')
    expect(generic._matchedTerms).not.toContain('joytopia')
  })
})

describe('CAUSE 2 — near-duplicate suppression', () => {
  const QUERY = 'LRI binary parsing format'

  it('reproduces the baseline failure without duplicate suppression', () => {
    // Pinning the bug: the whole window is one governance rule said five ways, and the
    // entry describing the actual binary format is outside it. P@5 = 0.0.
    const before = preFixRank(LRI_CANDIDATES, QUERY)
    expect(before.slice(0, 5).every(isGovernanceVariant)).toBe(true)
    expect(ids(before).slice(0, 5)).not.toContain('lri-binary-format-spec')
  })

  it('surfaces the entry describing the actual format — the baseline failing case', () => {
    const ranked = rank(LRI_CANDIDATES, QUERY)
    expect(ids(ranked).slice(0, 5)).toContain('lri-binary-format-spec')
    expect(ids(ranked).indexOf('lri-binary-format-spec')).toBeLessThanOrEqual(1)
  })

  it('stops one paraphrase cluster owning the window', () => {
    const ranked = rank(LRI_CANDIDATES, QUERY)
    expect(ranked.slice(0, 5).filter(isGovernanceVariant).length).toBeLessThanOrEqual(2)
    // The cluster keeps its single best representative at the top — the rule is still a
    // legitimate hit for this query, it just may not be five of the five.
    expect(ranked[0].id).toBe('gov-1')
    expect(ranked[0]._duplicateOf).toBeNull()
  })

  it('demotes duplicates rather than dropping them', () => {
    const ranked = rank(LRI_CANDIDATES, QUERY)
    expect(ranked).toHaveLength(LRI_CANDIDATES.length)
    expect(ranked.filter(isGovernanceVariant)).toHaveLength(5)
  })

  it('compounds the penalty so a large cluster cannot creep back up the list', () => {
    const ranked = rank(LRI_CANDIDATES, QUERY)
    const demoted = ranked.filter((r: any) => r._duplicateOf !== null)
    expect(demoted.length).toBe(4)
    const penalties = demoted.map((r: any) => r._duplicatePenalty)
    // Strictly decreasing: 0.45, 0.2025, 0.0911, …
    for (let i = 1; i < penalties.length; i++) {
      expect(penalties[i]).toBeLessThan(penalties[i - 1])
    }
    for (const r of demoted) {
      expect(r._duplicateOf).toBe('gov-1')
      expect(r._duplicateSimilarity).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('keeps the demoted variants below the distinct entries they were crowding out', () => {
    const ranked = rank(LRI_CANDIDATES, QUERY)
    const spec = ranked.find((r: any) => r.id === 'lri-binary-format-spec')
    for (const r of ranked.filter((x: any) => x._duplicateOf !== null)) {
      expect(r._score).toBeLessThan(spec._score)
    }
  })

  it('exposes the new signal on every result, demoted or not', () => {
    const ranked = rank(LRI_CANDIDATES, QUERY)
    for (const r of ranked) {
      expect(r).toHaveProperty('_duplicateOf')
      expect(r).toHaveProperty('_duplicateSimilarity')
      expect(r).toHaveProperty('_duplicatePenalty')
      expect(r).toHaveProperty('_score')
      expect(r).toHaveProperty('_relevance')
      expect(r).toHaveProperty('_recency')
    }
    const untouched = ranked.filter((r: any) => r._duplicateOf === null)
    for (const r of untouched) expect(r._duplicatePenalty).toBe(1)
  })

  it('scores real paraphrases above the threshold and distinct entries well below it', () => {
    // The margin the threshold sits in. Paraphrases of one rule cluster at 0.70-0.89;
    // distinct entries that merely share vocabulary top out around 0.27.
    expect(jaccard(LRI_CANDIDATES[0].content, LRI_CANDIDATES[1].content)).toBeGreaterThan(0.6)
    expect(jaccard(LRI_CANDIDATES[0].content, LRI_CANDIDATES[2].content)).toBeGreaterThan(0.6)
    expect(jaccard(LRI_CANDIDATES[0].content, LRI_CANDIDATES[8].content)).toBeLessThan(0.3)
  })
})

describe('near-duplicate suppression is conservative', () => {
  // The mandate: genuinely distinct entries that merely share vocabulary must NOT be
  // collapsed. Every pair below is two different facts; none may be demoted.
  const distinctPairs: Array<[string, string, string]> = [
    [
      'two different Ollama facts',
      'The Ollama classify timeout was raised from 3000ms to 8000ms after a cold model load measured 5219ms on the LAN host.',
      'The Ollama availability probe caches its result for 30 seconds, and a failed probe expires fast so one slow check does not disable embedding.',
    ],
    [
      'two steps of one procedure',
      'Step one of the SparrowDB node build: run the build-sparrowdb-node script from the KMSmcp repo root so the local unpublished artifact is produced.',
      'Step two of the SparrowDB node build: copy the produced binary over the file that npm installed into node modules, because a plain npm ci silently reverts it.',
    ],
    [
      'templated one-liners about different services',
      'The KMS MCP server listens on port 8180 and is exposed through the Cloudflare tunnel at kms.yaker.org.',
      'The Claude Ops dashboard listens on port 9102 and is exposed through the Cloudflare tunnel at cops.yaker.org.',
    ],
    [
      'two rows of one threshold table',
      'The dedup gate refuse band starts at cosine 0.88; procedure content type overrides that refuse threshold down to 0.85 because refutation rewrites cluster lower.',
      'The dedup gate confirm band runs from cosine 0.78 to 0.88; pattern content type overrides the refuse threshold up to 0.92 because pattern duplicates are extremely tight.',
    ],
    [
      'two different facts about the same binary format',
      'The LRI binary format opens with a 32-byte header whose magic is LRI and a null byte, followed by a table of per-camera blocks.',
      'The LRI binary format block table starts at offset 0x10 with a block count, then fixed-size per-camera descriptors follow immediately.',
    ],
    [
      'two projects\' brand colors',
      'Tengo portal-frontend brand colors: primary brand color is navy with a secondary amber accent, all brand colors live in the tailwind config theme extend colors block.',
      'BlockCopy26 rebrand shipped new brand colors, deep violet primary with slate neutrals; the old brand colors were retired from the design tokens package.',
    ],
    [
      'a fact and its correction',
      'Phoenix camera count is 6 per the March 2026 calibration session run against config 2 with the folded optical path.',
      'Phoenix camera count is UNKNOWN pending canvas bounds verification; the prior 6-camera claim used the wrong zoom config and an A-only field of view.',
    ],
    [
      'two behaviours of one tool',
      'kms_supersede stores a new entry with metadata.supersedes set to the old id and flags the old entry SUPERSEDED, so the old one is hidden from search but preserved for audit.',
      'kms_supersede probes each backend with findById first, builds the required backend set from those probes, and rolls back the new entry if any required flag write fails.',
    ],
    [
      'two distinct prose rules on one topic',
      'Every subagent must report file paths as absolute paths, never relative ones, because the parent agent resolves them from a different working directory.',
      'Every subagent should return its findings in the final message rather than writing a report file, because the parent agent reads the text output and not the filesystem.',
    ],
  ]

  it.each(distinctPairs)('does not collapse %s', (_label, a, b) => {
    const ranked = rank(
      [
        { id: 'a', content: a, confidence: 1, timestamp: daysAgo(1) },
        { id: 'b', content: b, confidence: 1, timestamp: daysAgo(1) },
      ],
      'irrelevant query terms',
    )
    for (const r of ranked) {
      expect(r._duplicateOf).toBeNull()
      expect(r._duplicatePenalty).toBe(1)
    }
  })

  it('vetoes on conflicting literals even when the prose overlaps heavily', () => {
    // The port-registry shape: same sentence template, different service. Word overlap
    // alone puts it uncomfortably near the threshold; the values say they are not the
    // same fact.
    const a = 'The KMS MCP server listens on port 8180 and is exposed through the Cloudflare tunnel at kms.yaker.org.'
    const b = 'The Claude Ops dashboard listens on port 9102 and is exposed through the Cloudflare tunnel at cops.yaker.org.'
    expect(jaccard(a, b)).toBeGreaterThan(0.3)   // high enough to be a worry
    const conflict = (tool as any).literalsConflict(
      (tool as any).literalTokens(contentTokens(a)),
      (tool as any).literalTokens(contentTokens(b)),
    )
    expect(conflict).toBe(true)
  })

  it('lets a paraphrase drop a detail without tripping the veto', () => {
    // Containment, not equality: {0.88} inside {0.88, 0.85} is an omission, not a
    // substitution, so a genuine rewording that mentions fewer numbers still clusters.
    const full = (tool as any).literalTokens(new Set(['0.88', '0.85']))
    const partial = (tool as any).literalTokens(new Set(['0.88']))
    expect((tool as any).literalsConflict(full, partial)).toBe(false)
    // …and when neither side cites a value there is nothing to veto on.
    expect((tool as any).literalsConflict(new Set(), new Set(['0.88']))).toBe(false)
  })

  it('exempts very short entries in both directions', () => {
    // Jaccard is noise on a handful of tokens: these two score 0.75 while meaning
    // opposite things, so entries this short are neither demoted nor allowed to demote.
    const a = 'Rich prefers dark mode in every editor'
    const b = 'Rich prefers light mode in every editor'
    expect(jaccard(a, b)).toBeGreaterThan(0.5)
    const ranked = rank(
      [
        { id: 'dark', content: a, confidence: 1, timestamp: daysAgo(1) },
        { id: 'light', content: b, confidence: 1, timestamp: daysAgo(2) },
      ],
      'Rich editor mode',
    )
    for (const r of ranked) expect(r._duplicateOf).toBeNull()
  })

  it('handles empty and single-result sets', () => {
    expect(rank([], 'anything')).toEqual([])
    const one = rank([{ id: 'x', content: 'a single entry about parsing the LRI binary format header', confidence: 1, timestamp: daysAgo(1) }], 'LRI format')
    expect(one).toHaveLength(1)
    expect(one[0]._duplicateOf).toBeNull()
    expect(one[0]._duplicatePenalty).toBe(1)
  })

  it('tolerates results with missing or non-string content', () => {
    const ranked = rank(
      [
        { id: 'ok', content: 'LRI binary format header parsing details', confidence: 1, timestamp: daysAgo(1) },
        { id: 'empty', content: '', confidence: 1, timestamp: daysAgo(1) },
        { id: 'missing', confidence: 1, timestamp: daysAgo(1) },
      ],
      'LRI binary format',
    )
    expect(ranked).toHaveLength(3)
    expect(ranked[0].id).toBe('ok')
    for (const r of ranked) expect(Number.isFinite(r._score)).toBe(true)
  })
})

describe('both fixes compose without undoing the behaviour already in place', () => {
  it('still damps a long off-topic note against a short exact match', () => {
    const megaNote = {
      id: 'mega',
      content: 'Session log. ' + 'Assorted unrelated work across many projects. '.repeat(70) + 'Ollama classify timeout mentioned once. ',
      confidence: 1,
      timestamp: daysAgo(0),
    }
    const precise = { id: 'precise', content: 'Ollama classify timeout raised from 3000ms to 8000ms.', confidence: 1, timestamp: daysAgo(45) }
    expect(rank([megaNote, precise], 'Ollama classify timeout')[0].id).toBe('precise')
  })

  it('still uses recency as a tie-breaker, not a trump card', () => {
    const results = [
      { id: 'new-irrelevant', content: 'unrelated note about jewellery auctions in the spring catalogue', confidence: 1, timestamp: daysAgo(0) },
      { id: 'old-relevant', content: 'Ollama classify timeout budget raised; probe widened; classification restored', confidence: 1, timestamp: daysAgo(300) },
    ]
    expect(rank(results, 'Ollama classify timeout budget')[0].id).toBe('old-relevant')
  })

  it('still refuses substring matches once term weighting is in play', () => {
    const results = [
      { id: 'substring', content: 'the timeoutvalue setting was left at its default across the whole cluster', confidence: 1, timestamp: daysAgo(0) },
      { id: 'real', content: 'the classify timeout was raised after the probe measured a slow cold load', confidence: 1, timestamp: daysAgo(200) },
    ]
    const ranked = rank(results, 'timeout')
    expect(ranked[0].id).toBe('real')
    expect(ranked.find((r: any) => r.id === 'substring')._relevance).toBe(0)
  })
})
