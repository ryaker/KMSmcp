/**
 * Discriminates "the `sparrowdb` package itself isn't resolvable" (genuinely
 * not installed — the legitimate case a dev-tree fallback exists for) from
 * every other load failure (corrupt/partial node_modules, an ABI mismatch
 * after a Node upgrade, a missing platform binary) — a broken install that
 * must fail loudly rather than silently degrade to an unpinned, unversioned
 * binary. See issue #99.
 *
 * `require('sparrowdb')` throws `MODULE_NOT_FOUND` for BOTH cases, so the
 * code alone can't tell them apart. Verified with a real Node process: a
 * genuinely-missing top-level package throws `Cannot find module 'sparrowdb'`
 * (the bare specifier); a package that resolves but whose own `index.js`
 * requires a missing internal file names THAT path instead — e.g. `Cannot
 * find module './sparrowdb.linux-x64-gnu.node'` — never the bare specifier.
 * Checking the message, not just the code, is what tells them apart.
 *
 * Dependency-free (no `import.meta.url`, no fs) so it is directly
 * `require`/import-able from a Jest test, unlike SparrowDBStorage.ts and
 * cli/kms.ts, which both import this rather than duplicating the check.
 */
export function isSparrowdbPackageNotInstalled(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' &&
    err.message.startsWith("Cannot find module 'sparrowdb'")
  )
}
