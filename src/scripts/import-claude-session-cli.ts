/**
 * Thin CLI entry point for the Claude Code session → KMS review-queue importer.
 *
 * The actual implementation lives in `import-claude-session.ts`, which is
 * import-only / side-effect-free so its symbols can be unit-tested under
 * ts-jest without a top-level `import.meta` reference (which the test runner's
 * CJS loader rejects). Mirrors `import-slack-huddles-cli.ts`.
 *
 * Run: `node dist/scripts/import-claude-session-cli.js [...flags]`
 *   or: `npx tsx src/scripts/import-claude-session-cli.ts [...flags]`
 */

import { main } from './import-claude-session.js'

main().catch(err => {
  console.error('fatal:', err)
  process.exit(1)
})
