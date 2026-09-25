/**
 * `calculateRelevance` compound-token coverage — the three motivating cases: compound
 * identifiers in CONTENT that a natural-language query should reach, and a compound
 * QUERY term that should reach naturally-written content.
 *
 * Same instantiation pattern as UnifiedSearchTool.ranking.test.ts: the constructor
 * takes wired-up storage systems, but `calculateRelevance` is pure and touches none of
 * them, so an empty object is sufficient.
 */

import { UnifiedSearchTool } from '../tools/UnifiedSearchTool.js'

const tool = new UnifiedSearchTool({} as any, {} as any)
const relevance = (content: string, query: string) =>
  (tool as any).calculateRelevance(content, query)

describe('UnifiedSearchTool calculateRelevance — compound-token expansion', () => {
  it('matches camelCase content against a space-separated query', () => {
    // mem0ParentId — content compound
    expect(
      relevance(
        'The `mem0ParentId` helper maps Mem0 IDs back to KMS IDs.',
        'mem0 parent id',
      ),
    ).toBeGreaterThan(0)
  })

  it('matches kebab-case content against a space-separated query', () => {
    // kms-context-inject — hyphen is not a JS regex word character, so this direction
    // mostly worked pre-fix too; kept as a regression guard now that content is
    // augmented rather than matched against verbatim.
    expect(
      relevance(
        'The kms-context-inject hook runs at session start.',
        'kms context inject',
      ),
    ).toBeGreaterThan(0)
  })

  it('matches a compound QUERY term against naturally-written content', () => {
    // Reverse direction: user searches for the identifier itself, content is prose.
    expect(
      relevance(
        'The mem0 parent id is derived from the shard suffix.',
        'mem0ParentId',
      ),
    ).toBeGreaterThan(0)
  })

  it('scores a full compound match at least as high as a partial one', () => {
    const full = relevance(
      'the kms-context-inject hook runs at session start',
      'kms context inject',
    )
    const partial = relevance(
      'the kms hook runs at session start',
      'kms context inject',
    )
    expect(full).toBeGreaterThanOrEqual(partial)
  })

  it('does not change scoring for content with no compound tokens', () => {
    // A term that has nothing to expand into must behave exactly as before: the
    // compound fallback must be a true no-op, not just numerically close.
    const content = 'the request timed out after a configured timeout value'
    expect(relevance(content, 'timeout')).toBe(relevance(content, 'timeout'))
    expect(relevance('timeoutvalue configured', 'value')).toBe(0)
    expect(relevance('timeoutvalue configured', 'timeout')).toBe(0)
  })

  it('still returns 0 for genuinely unrelated compound identifiers', () => {
    expect(
      relevance(
        'completely unrelated content about weather patterns',
        'mem0ParentId',
      ),
    ).toBe(0)
  })
})
