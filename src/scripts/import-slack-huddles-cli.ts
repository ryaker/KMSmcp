/**
 * Thin CLI entry point for the Slack Huddle → KMS Importer.
 *
 * The actual implementation lives in `import-slack-huddles.ts`, which is
 * import-only / side-effect-free so its symbols can be unit-tested under
 * ts-jest without a top-level `import.meta` reference (which the test
 * runner's CJS loader rejects).
 *
 * Run: `node dist/scripts/import-slack-huddles-cli.js [...flags]`
 *   or: `npx tsx src/scripts/import-slack-huddles-cli.ts [...flags]`
 */

import { main } from './import-slack-huddles.js'

main().catch(err => {
  console.error('fatal:', err)
  process.exit(1)
})
