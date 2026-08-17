/**
 * Guards the single-canonical-default fix for the dual-root bug: two
 * different defaults (`~/.kms-sparrowdb` and `~/.kms-sparrowdb-v2`) existed
 * side by side, so `kms export`/`kms import` silently operated on a stale,
 * five-month-old snapshot while the MCP server read/wrote the live one.
 *
 * Every call site that needs a SparrowDB root now goes through
 * `resolveSparrowDBPath()` in storage/sparrowDbPath.ts instead of inlining
 * its own `join(homedir(), '.kms-sparrowdb...')`. Three things are asserted:
 *
 *   1. resolveSparrowDBPath()'s precedence (explicit > $SPARROWDB_PATH >
 *      canonical default).
 *   2. SparrowDBStorage's constructor is wired through the SAME function —
 *      not a second, independently-typed default. Checked by source
 *      inspection rather than by instantiating the class: SparrowDBStorage.ts
 *      has an unrelated, pre-existing `const __dirname =
 *      dirname(fileURLToPath(import.meta.url))` at module scope that this
 *      project's Jest config (CJS-executed despite the ESM preset — no
 *      `--experimental-vm-modules`, see jest.config.js) cannot parse, so the
 *      class itself cannot be `require`d/imported from a test today. That is
 *      a real, separate gap this fix does not attempt to close; extracting
 *      the resolver into the dependency-free storage/sparrowDbPath.ts (no
 *      `import.meta.url`) is what makes THIS function testable at all.
 *   3. A source scan: no file other than storage/sparrowDbPath.ts may
 *      contain a hardcoded `.kms-sparrowdb` path literal. That is what
 *      actually prevents regression — a test asserting behaviour only in
 *      the one file that already agrees with itself proves nothing about
 *      the other places the string used to live.
 *
 * Uses only temp directories / an in-memory env var — never the real
 * ~/.kms-sparrowdb or ~/.kms-sparrowdb-v2 roots, which are live data.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { DEFAULT_SPARROWDB_DIRNAME, resolveSparrowDBPath } from '../storage/sparrowDbPath.js'

const ORIGINAL_SPARROWDB_PATH = process.env.SPARROWDB_PATH

afterEach(() => {
  if (ORIGINAL_SPARROWDB_PATH === undefined) delete process.env.SPARROWDB_PATH
  else process.env.SPARROWDB_PATH = ORIGINAL_SPARROWDB_PATH
})

describe('resolveSparrowDBPath', () => {
  it('defaults to the canonical ~/.kms-sparrowdb-v2 root when nothing else is set', () => {
    delete process.env.SPARROWDB_PATH
    expect(resolveSparrowDBPath()).toBe(join(homedir(), '.kms-sparrowdb-v2'))
    expect(DEFAULT_SPARROWDB_DIRNAME).toBe('.kms-sparrowdb-v2')
  })

  it('lets $SPARROWDB_PATH override the default', () => {
    process.env.SPARROWDB_PATH = '/tmp/kms-test-env-override'
    expect(resolveSparrowDBPath()).toBe('/tmp/kms-test-env-override')
  })

  it('lets an explicit argument override both the env var and the default', () => {
    process.env.SPARROWDB_PATH = '/tmp/kms-test-env-override'
    expect(resolveSparrowDBPath('/tmp/kms-test-explicit')).toBe('/tmp/kms-test-explicit')
  })

  it('ignores an empty-string explicit argument and falls through to env/default', () => {
    delete process.env.SPARROWDB_PATH
    expect(resolveSparrowDBPath('')).toBe(join(homedir(), '.kms-sparrowdb-v2'))
  })
})

describe('SparrowDBStorage constructor is wired to the shared resolver', () => {
  // Cannot `new SparrowDBStorage()` here — see file header: the class module
  // has an unrelated pre-existing import.meta.url usage this Jest config
  // can't load. Assert the wiring by source inspection instead: the
  // constructor must call resolveSparrowDBPath(config?.dbPath) and must NOT
  // contain its own inline '.kms-sparrowdb' fallback (that inline fallback,
  // missing the '-v2', was the actual bug).
  const SOURCE = readFileSync(join(__dirname, '..', 'storage', 'SparrowDBStorage.ts'), 'utf8')

  it('constructor delegates to resolveSparrowDBPath(config?.dbPath)', () => {
    const ctorMatch = SOURCE.match(/constructor\(config\?: SparrowDBConfig\) \{([\s\S]*?)\n  \}/)
    expect(ctorMatch).not.toBeNull()
    const ctorBody = ctorMatch![1]
    expect(ctorBody).toMatch(/resolveSparrowDBPath\(config\?\.dbPath\)/)
    expect(ctorBody).not.toMatch(/['"`]\.kms-sparrowdb['"`]/)
  })

  it('imports resolveSparrowDBPath from the shared sparrowDbPath module', () => {
    expect(SOURCE).toMatch(/import \{[^}]*resolveSparrowDBPath[^}]*\} from '\.\/sparrowDbPath\.js'/)
  })
})

describe('single canonical default — no duplicated path literal anywhere else', () => {
  // Walk src/, excluding the one file allowed to define the literal
  // (storage/sparrowDbPath.ts) and test files, and fail if any other file
  // hardcodes a `.kms-sparrowdb` / `.kms-sparrowdb-v2` string literal.
  // This is the regression guard: before the fix, index.ts, cli/kms.ts
  // (x4), scripts/backfill-hnsw-embeddings.ts, and SparrowDBStorage.ts's
  // own constructor each carried their own copy — two different values —
  // instead of importing a shared one.

  // The test runner compiles this file to CommonJS, where `__dirname` is
  // available (unlike `import.meta.url`, a parse error there — see
  // SparrowDBBinding.reads.test.ts for the same workaround).
  const SRC_ROOT = join(__dirname, '..')
  const ALLOWED_FILE = join(SRC_ROOT, 'storage', 'sparrowDbPath.ts')
  const LITERAL_RE = /['"`]\/?\.kms-sparrowdb(-v2)?['"`]/

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue
        walk(p, out)
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(p)
      }
    }
    return out
  }

  it('has zero hardcoded .kms-sparrowdb path literals outside sparrowDbPath.ts', () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      if (file === ALLOWED_FILE) continue
      const contents = readFileSync(file, 'utf8')
      const lines = contents.split('\n')
      lines.forEach((line, i) => {
        if (LITERAL_RE.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
