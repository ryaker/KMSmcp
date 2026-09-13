/**
 * Guards loadNativeBinding()'s fail-loudly fix (issue #99): a `sparrowdb`
 * package that's installed but broken (corrupt node_modules, ABI mismatch
 * after a Node upgrade, missing platform binary) must throw, not silently
 * fall through to an unpinned, unversioned dev-tree binary.
 *
 * The predicate itself (`isSparrowdbPackageNotInstalled`) is behaviourally
 * tested against real Node error shapes in nativeLoaderGuard.test.ts; this
 * only guards that loadNativeBinding actually gates on it in the right
 * place, before the dev-tree fallback.
 *
 * Source inspection only — SparrowDBStorage.ts has a top-level
 * `dirname(fileURLToPath(import.meta.url))`, which this project's Jest
 * config cannot parse (same precedent as
 * SparrowDBStorage.resolveSparrowDBPath.test.ts and
 * kms.loadSparrowDBNative.test.ts). Never opens a real SparrowDB database.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(join(__dirname, '..', 'storage', 'SparrowDBStorage.ts'), 'utf8')

function extractFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const braceIdx = source.indexOf('{', start)
  const endMarker = source.indexOf('\n}', braceIdx)
  expect(endMarker).toBeGreaterThan(-1)
  return source.slice(braceIdx, endMarker)
}

describe('loadNativeBinding fails loudly on a broken (not merely absent) install', () => {
  const body = extractFunctionBody(SOURCE, 'loadNativeBinding')

  it('imports the shared guard rather than re-implementing the discrimination inline', () => {
    expect(SOURCE).toMatch(/import \{ isSparrowdbPackageNotInstalled \} from ['"]\.\/nativeLoaderGuard\.js['"]/)
  })

  it('gates on the guard between the npm require and the dev-tree fallback', () => {
    const npmIdx = body.search(/require\(\s*['"]sparrowdb['"]\s*\)/)
    const guardIdx = body.indexOf('isSparrowdbPackageNotInstalled(err)')
    const fallbackIdx = body.indexOf('candidates')
    expect(guardIdx).toBeGreaterThan(npmIdx)
    expect(guardIdx).toBeLessThan(fallbackIdx)
  })

  it('throws — does not merely log — when the guard says the install is broken', () => {
    const guardIdx = body.indexOf('isSparrowdbPackageNotInstalled(err)')
    const nextCommentIdx = body.indexOf('// Package genuinely not installed', guardIdx)
    expect(nextCommentIdx).toBeGreaterThan(guardIdx)
    expect(body.slice(guardIdx, nextCommentIdx)).toMatch(/throw new Error/)
  })
})
