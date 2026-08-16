/**
 * Canonical SparrowDB root-path resolution.
 *
 * There is exactly ONE default SparrowDB root for this codebase. Every call
 * site that needs a path — the MCP server (index.ts), the CLI (cli/kms.ts,
 * including `kms export`/`kms import`), the backfill script, and
 * SparrowDBStorage's own constructor — MUST resolve it through
 * `resolveSparrowDBPath()` rather than inlining its own
 * `join(homedir(), '.kms-sparrowdb...')`. A second copy of the string is how
 * a stale root silently comes back into use: before this file existed,
 * `kms export`/`kms import` and SparrowDBStorage's own constructor default
 * disagreed with the MCP server's default (`.kms-sparrowdb` vs
 * `.kms-sparrowdb-v2`), so `kms export` was quietly backing up a five-month
 * stale snapshot instead of the live database.
 *
 * Deliberately dependency-free (no native binding, no `import.meta.url`) so
 * it can be imported — and unit tested — on its own without pulling in the
 * rest of SparrowDBStorage.ts.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory name (under $HOME) of the live SparrowDB root. */
export const DEFAULT_SPARROWDB_DIRNAME = '.kms-sparrowdb-v2'

/**
 * Resolve the SparrowDB root path with the canonical precedence:
 *   1. an explicit path passed by the caller (e.g. a CLI --path flag)
 *   2. $SPARROWDB_PATH
 *   3. the canonical default, ~/.kms-sparrowdb-v2
 */
export function resolveSparrowDBPath(explicitPath?: string): string {
  return explicitPath || process.env.SPARROWDB_PATH || join(homedir(), DEFAULT_SPARROWDB_DIRNAME)
}
