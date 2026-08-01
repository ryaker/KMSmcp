/**
 * Characterisation tests for what the sparrowdb native binding actually does
 * on a read. These run against a real throwaway database, not a fake, because
 * their entire purpose is to be the thing you run before writing another
 * sentence about SparrowDB read behaviour into a comment or into CLAUDE.md.
 *
 * Two claims that were documented as fact and were not:
 *
 *   1. "SparrowDB truncates string properties to 7 characters on read."
 *      False. It cost a prefix-matching resolver in SparrowDBStorage written
 *      to compensate for a non-problem, and two invalid review findings on
 *      PR #87 reasoning from it.
 *
 *   2. "Reads return null unless id(k) is projected first — MATCH (k) RETURN
 *      k.id yields null, MATCH (k) RETURN id(k), k.id yields the value."
 *      False as stated: both forms return identical values. One investigation
 *      saw nulls, another could not reproduce them, and the reason is the real
 *      defect covered below — it is about the RETURN *alias*, not about id().
 *
 * The real defect: in a node-scan projection the engine resolves a property
 * column by its OUTPUT NAME rather than by the projected expression. So
 * `RETURN k.id AS zzz` reads a property named `zzz` (null), and
 * `RETURN k.id AS contentType` silently hands back k.contentType. Projecting
 * anything that materialises the node (`id(k)`, `labels(k)`, the variable `k`)
 * restores correct resolution, which is why `_ensureInternalIdMap` is immune.
 */

import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Resolved from the working directory rather than `import.meta.url`: the test
// runner compiles this file to CommonJS, where `import.meta` is a parse error.
const require_ = createRequire(join(process.cwd(), 'jest-resolve-anchor.cjs'))

interface QueryResult { columns: string[]; rows: Array<Record<string, unknown>> }
interface Db { execute(cypher: string): QueryResult; checkpoint(): void }

/**
 * The binding is a locally built darwin-arm64 artifact (see
 * scripts/build-sparrowdb-node.sh); it is legitimately absent on a machine
 * that has not run that script. Skip rather than fail there — but never skip
 * an individual assertion.
 */
let SparrowDB: { open(path: string): Db } | null = null
try {
  SparrowDB = require_('sparrowdb').SparrowDB
} catch {
  SparrowDB = null
}

const describeIfBinding = SparrowDB ? describe : describe.skip

const UUID_A = '11111111-2222-3333-4444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LONG_CONTENT = 'content far longer than seven characters, forty-plus in fact'

describeIfBinding('sparrowdb binding — read behaviour', () => {
  let dir: string
  let db: Db

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kms-sparrow-reads-'))
    db = SparrowDB!.open(join(dir, 'scratch.db'))
    db.execute(
      `CREATE (k:Knowledge {id: '${UUID_A}', contentType: 'insight', ` +
      `source: 'personal', content: '${LONG_CONTENT}'})`
    )
    db.execute(`CREATE (k:Knowledge {id: '${UUID_B}', contentType: 'preference', source: 'personal'})`)
    db.execute(
      `MATCH (a:Knowledge {id: '${UUID_A}'}), (b:Knowledge {id: '${UUID_B}'}) ` +
      `CREATE (a)-[r:RELATED_TO {strength: 85}]->(b)`
    )
    db.checkpoint()
  })

  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  })

  // -------------------------------------------------------------------------
  // Claim 1: string truncation
  // -------------------------------------------------------------------------

  describe('string properties are not truncated', () => {
    it('a 36-char UUID round-trips whole through a bare projection', () => {
      const ids = db.execute('MATCH (k:Knowledge) RETURN k.id').rows.map(r => r['k.id'])
      expect(ids).toContain(UUID_A)
      expect(ids).toContain(UUID_B)
      expect(ids.every(v => String(v).length === 36)).toBe(true)
    })

    it('non-id string properties round-trip whole, including a 60-char value', () => {
      const row = db.execute(
        `MATCH (k:Knowledge {id: '${UUID_A}'}) RETURN k.id, k.contentType, k.source, k.content`
      ).rows[0]
      expect(row['k.id']).toBe(UUID_A)
      expect(row['k.contentType']).toBe('insight')
      expect(row['k.source']).toBe('personal')
      expect(row['k.content']).toBe(LONG_CONTENT)
    })

    it('the exact query GraphEdgeIndex.readEdges() issues returns whole ids on both endpoints', () => {
      // Verbatim from GraphEdgeIndex.readEdges().
      const rows = db.execute('MATCH (a)-[r:RELATED_TO]->(b) RETURN a.id, b.id, r.strength').rows
      expect(rows).toHaveLength(1)
      expect(rows[0]['a.id']).toBe(UUID_A)
      expect(rows[0]['b.id']).toBe(UUID_B)
      expect(rows[0]['r.strength']).toBe(85)
    })

    it('every string a read returns is a value we wrote, never a prefix of one', () => {
      const written = new Set([UUID_A, UUID_B, 'insight', 'preference', 'personal', LONG_CONTENT])
      const shapes = [
        'MATCH (k:Knowledge) RETURN k.id',
        'MATCH (k:Knowledge) RETURN k.contentType',
        'MATCH (k:Knowledge) RETURN k.content',
        'MATCH (k:Knowledge) RETURN k.id, k.contentType, k.source, k.content',
        'MATCH (k:Knowledge) RETURN id(k), k.id',
        'MATCH (a)-[r:RELATED_TO]->(b) RETURN a.id, b.id',
      ]
      const seen: string[] = []
      for (const cypher of shapes) {
        for (const row of db.execute(cypher).rows) {
          for (const value of Object.values(row)) {
            if (typeof value !== 'string') continue
            seen.push(value)
            // A clipped read would be a strict prefix of what we wrote and so
            // would not be in the set.
            expect(written).toContain(value)
          }
        }
      }
      expect(seen.length).toBeGreaterThan(10)
    })
  })

  // -------------------------------------------------------------------------
  // Claim 2: "reads return null unless id(k) is projected first"
  // -------------------------------------------------------------------------

  describe('projecting id(k) is not what makes a property readable', () => {
    it('MATCH (k) RETURN k.id and MATCH (k) RETURN id(k), k.id agree exactly', () => {
      const without = db.execute('MATCH (k:Knowledge) RETURN k.id').rows.map(r => r['k.id'])
      const withId = db.execute('MATCH (k:Knowledge) RETURN id(k), k.id').rows.map(r => r['k.id'])
      expect(without.sort()).toEqual([UUID_A, UUID_B].sort())
      expect(withId.sort()).toEqual(without.sort())
    })

    it('id(k) projected last works the same as id(k) projected first', () => {
      const first = db.execute('MATCH (k:Knowledge) RETURN id(k), k.id').rows.map(r => r['k.id'])
      const last = db.execute('MATCH (k:Knowledge) RETURN k.id, id(k)').rows.map(r => r['k.id'])
      expect(last.sort()).toEqual(first.sort())
    })
  })

  // -------------------------------------------------------------------------
  // The defect that actually exists: RETURN aliases resolve by output name
  // -------------------------------------------------------------------------

  describe('RETURN aliases on a node scan resolve by output name, not by expression', () => {
    it('an alias that names no property reads null', () => {
      const rows = db.execute('MATCH (k:Knowledge) RETURN k.id AS zzz').rows
      expect(rows).toHaveLength(2)
      expect(rows.every(r => r['zzz'] === null)).toBe(true)
    })

    it('an alias naming a DIFFERENT property silently returns that other property', () => {
      // The dangerous shape: this reads like "give me the id" and returns the
      // contentType. Not an error, not a null — wrong data.
      const row = db.execute(
        `MATCH (k:Knowledge {id: '${UUID_A}'}) RETURN k.id AS contentType`
      ).rows[0]
      expect(row['contentType']).toBe('insight')
      expect(row['contentType']).not.toBe(UUID_A)
    })

    it('an alias equal to the property name is correct', () => {
      const rows = db.execute('MATCH (k:Knowledge) RETURN k.id AS id').rows.map(r => r['id'])
      expect(rows.sort()).toEqual([UUID_A, UUID_B].sort())
    })

    it('an unaliased projection is correct', () => {
      const rows = db.execute('MATCH (k:Knowledge) RETURN k.id').rows.map(r => r['k.id'])
      expect(rows.sort()).toEqual([UUID_A, UUID_B].sort())
    })

    it.each([
      ['id(k)', 'MATCH (k:Knowledge) RETURN id(k) AS nid, k.id AS node_id'],
      ['labels(k)', 'MATCH (k:Knowledge) RETURN labels(k) AS lbl, k.id AS node_id'],
      ['the node variable', 'MATCH (k:Knowledge) RETURN k, k.id AS node_id'],
    ])('projecting %s alongside makes an arbitrary alias resolve correctly', (_label, cypher) => {
      const rows = db.execute(cypher).rows.map(r => r['node_id'])
      expect(rows.sort()).toEqual([UUID_A, UUID_B].sort())
    })

    it('_ensureInternalIdMap survives only because it projects id(k)', () => {
      // Verbatim shape from SparrowDBStorage._ensureInternalIdMap().
      const rows = db.execute('MATCH (k:Knowledge) RETURN id(k) AS nid, k.id AS node_id').rows
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(typeof row['nid']).toBe('number')
        expect([UUID_A, UUID_B]).toContain(row['node_id'])
      }
      // Drop the id(k) column and the same alias goes null.
      const stripped = db.execute('MATCH (k:Knowledge) RETURN k.id AS node_id').rows
      expect(stripped.every(r => r['node_id'] === null)).toBe(true)
    })

    it('relationship-expansion projections are unaffected by the alias defect', () => {
      const row = db.execute('MATCH (a)-[r:RELATED_TO]->(b) RETURN a.id AS f, b.id AS t').rows[0]
      expect(row['f']).toBe(UUID_A)
      expect(row['t']).toBe(UUID_B)
    })
  })
})
