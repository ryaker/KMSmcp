/**
 * Thin CLI entry point for the Markdown Corpus → KMS Importer.
 *
 * The actual implementation lives in `import-md-corpus.ts`, which is
 * import-only / side-effect-free so its symbols can be unit-tested under
 * ts-jest without a top-level `import.meta` reference (which the test
 * runner's CJS loader rejects).
 *
 * Run: `node dist/scripts/import-md-corpus-cli.js [...flags]`
 */

import { main } from './import-md-corpus.js'

main().catch(err => {
  console.error('fatal:', err)
  process.exit(1)
})
