/**
 * isSparrowdbPackageNotInstalled — the discriminator behind issue #99's fix.
 *
 * Both loaders (SparrowDBStorage.ts, cli/kms.ts) fall back to an unpinned
 * dev-tree binary on MODULE_NOT_FOUND, which is correct ONLY when `sparrowdb`
 * itself is absent. The same code fires for "sparrowdb IS installed but its
 * own require() of a missing internal file fails" — a broken install that
 * must fail loudly instead. The two fixtures below are not guessed: they are
 * the exact `.code`/`.message` a real Node process produced for each case
 * (verified 2026-09-13 with `node -e` against both a genuinely-missing
 * top-level package and a package whose index.js requires a missing file).
 */

import { isSparrowdbPackageNotInstalled } from '../storage/nativeLoaderGuard.js'

function nodeModuleNotFound(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = 'MODULE_NOT_FOUND'
  return err
}

describe('isSparrowdbPackageNotInstalled', () => {
  it('is true for the real error Node throws when sparrowdb is not installed at all', () => {
    const err = nodeModuleNotFound(
      "Cannot find module 'sparrowdb'\nRequire stack:\n- /app/src/storage/SparrowDBStorage.ts"
    )
    expect(isSparrowdbPackageNotInstalled(err)).toBe(true)
  })

  it('is FALSE for the real error Node throws when sparrowdb is installed but its own internal require fails', () => {
    // This is the broken-install case #99 exists for: same code, different
    // module — the message names the internal file, never the bare specifier.
    const err = nodeModuleNotFound(
      "Cannot find module './sparrowdb.linux-x64-gnu.node'\n" +
      'Require stack:\n- /app/node_modules/sparrowdb/index.js\n- /app/src/storage/SparrowDBStorage.ts'
    )
    expect(isSparrowdbPackageNotInstalled(err)).toBe(false)
  })

  it('is false for a MODULE_NOT_FOUND naming an unrelated package', () => {
    const err = nodeModuleNotFound("Cannot find module 'some-other-package'")
    expect(isSparrowdbPackageNotInstalled(err)).toBe(false)
  })

  it('is false for a non-MODULE_NOT_FOUND error even if it mentions sparrowdb', () => {
    const err = new Error("sparrowdb: dlopen failed, incompatible architecture") as NodeJS.ErrnoException
    err.code = 'ERR_DLOPEN_FAILED'
    expect(isSparrowdbPackageNotInstalled(err)).toBe(false)
  })

  it('is false for a thrown non-Error value', () => {
    expect(isSparrowdbPackageNotInstalled('sparrowdb not found')).toBe(false)
    expect(isSparrowdbPackageNotInstalled(null)).toBe(false)
    expect(isSparrowdbPackageNotInstalled(undefined)).toBe(false)
  })
})
