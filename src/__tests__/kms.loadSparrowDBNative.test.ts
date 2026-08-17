/**
 * Guards the CLI native-loader fix: `loadSparrowDBNative()` in cli/kms.ts
 * used to resolve the native binding from three hardcoded paths inside a
 * `~/Dev/SparrowDB` source checkout, and NEVER looked at the installed
 * `sparrowdb` npm dependency at all. On a machine where that source-tree
 * path happened to contain a stale build (e.g. one that predates #524's
 * process lock), `kms export`/`kms import` would silently load it instead
 * of the correct, installed package version — walking straight past a
 * lock a newer binary would have respected.
 *
 * The fix: try the installed npm package first (a plain `require('sparrowdb')`,
 * letting Node + the package's own platform resolution pick the right
 * prebuilt binary), and only fall back to the source-tree dev-build paths
 * if that fails.
 *
 * Uses only source inspection — cli/kms.ts has a top-level
 * `createRequire(import.meta.url)` (same shape as SparrowDBStorage.ts's
 * `import.meta.url` usage), which this project's Jest config (CJS-executed
 * despite the ESM preset) cannot parse. See
 * SparrowDBStorage.resolveSparrowDBPath.test.ts for the same precedent/
 * workaround. Never opens a real SparrowDB database.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(join(__dirname, '..', 'cli', 'kms.ts'), 'utf8')

function extractFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  // Grab from the function's opening brace to its closing `}` at column 0,
  // which matches this file's existing top-level-function formatting.
  const braceIdx = source.indexOf('{', start)
  const endMarker = source.indexOf('\n}', braceIdx)
  expect(endMarker).toBeGreaterThan(-1)
  return source.slice(braceIdx, endMarker)
}

describe('loadSparrowDBNative prefers the installed npm dependency', () => {
  const body = extractFunctionBody(SOURCE, 'loadSparrowDBNative')

  it('calls require(\'sparrowdb\') — not a reconstructed node_modules path or a hardcoded platform filename', () => {
    expect(body).toMatch(/require\(\s*['"]sparrowdb['"]\s*\)/)
    // Regression guard scoped to the npm-preferring section only (up to the
    // source-tree fallback's `candidatePaths` array, which legitimately
    // still names a local dev-build file `sparrowdb.node` — that generic
    // name was removed only from the *published* package, not from the
    // documented local `cargo build` convenience path). The npm attempt
    // itself must never reconstruct a path into node_modules or hardcode a
    // platform-specific filename — that would defeat the package's own
    // platform selection (platforms.js).
    const npmSection = body.slice(0, body.indexOf('candidatePaths'))
    expect(npmSection).not.toMatch(/node_modules.*sparrowdb/)
    expect(npmSection).not.toMatch(/sparrowdb\.node/)
  })

  it('tries the npm dependency before the source-tree fallback paths', () => {
    const npmIdx = body.search(/require\(\s*['"]sparrowdb['"]\s*\)/)
    const fallbackIdx = body.indexOf('candidatePaths')
    expect(npmIdx).toBeGreaterThan(-1)
    expect(fallbackIdx).toBeGreaterThan(-1)
    expect(npmIdx).toBeLessThan(fallbackIdx)
  })

  it('keeps the source-tree paths only as a fallback (inside a try or after the npm attempt), never unconditionally', () => {
    // The npm attempt must be inside its own try/catch so a load failure
    // there falls through instead of throwing past the fallback logic.
    const tryIdx = body.indexOf('try {')
    const npmIdx = body.search(/require\(\s*['"]sparrowdb['"]\s*\)/)
    expect(tryIdx).toBeGreaterThan(-1)
    expect(tryIdx).toBeLessThan(npmIdx)
  })

  it('does not silently swallow the failure — some diagnostic naming what was tried precedes the null return', () => {
    // Not asserting exact wording, only that a failure to resolve anything
    // is reported somewhere (console.error/console.warn) before returning,
    // rather than returning null with zero trace of what was attempted.
    const nullReturnIdx = body.lastIndexOf('return null')
    expect(nullReturnIdx).toBeGreaterThan(-1)
    const beforeReturn = body.slice(0, nullReturnIdx)
    expect(beforeReturn).toMatch(/console\.(error|warn)\(/)
  })
})
