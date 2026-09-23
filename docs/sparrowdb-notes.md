# SparrowDB notes: verified behavior and retired claims

Moved out of `CLAUDE.md` on 2026-09-23. **Read this before writing any SparrowDB query or
anything about SparrowDB into `CLAUDE.md`.** Several claims about this engine were
confidently wrong for months. Each one below states what was verified and how.

## Embedding writes work, and the dedup gate is live

- The binding exposes `executeWithParams`, `createVectorIndex`, `vectorSearch`,
  `addToVectorIndex`, `hybridSearch`, `fulltextSearch`.
- `storeEmbedding` (`src/storage/SparrowDBStorage.ts`) writes the vector with
  `executeWithParams` and `SET k.embedding = $emb`. This works because the server creates a
  vector index on `(Knowledge, embedding)` at startup (`createVectorIndex`, same file). Without
  that index the engine rejects a list value ("property value is a list, which has no scalar
  storage representation"), which is what a bare scratch DB shows. Don't mistake that for
  a broken write path. Production logs had zero `storeEmbedding: graph SET failed` warnings
  on 2026-09-23.
- Only the *legacy* literal form fails, and nothing calls it any more:
  `SET k.embedding = [0.1, 0.2]` → `invalid argument: SET property value must be a literal
  or $parameter`.

## The npm package is the production artifact (as of 0.1.27)

Verified 2026-09-23. `package.json` declares `sparrowdb: ^0.1.27`, and npm latest is 0.1.27.
The published tarball ships `sparrowdb.darwin-arm64.node` (Mach-O arm64) and
`sparrowdb.linux-x64-gnu.node`. Its darwin binary is **byte-identical** (SHA-256) to the one
in KMSmcp's `node_modules`, and it has the full vector API. So `npm ci` installs exactly
what production runs.

**Retired:** "`package.json` declares `^0.1.20`, the npm tarball ships only a Linux ELF with
no vector API, the working binary is a local build from `scripts/build-sparrowdb-node.sh`,
and a plain `npm ci` silently breaks vector support." All of that was true of 0.1.20/0.1.21
and is false for 0.1.27. The build script's header comment still describes the old state.
Keep the script for testing unpublished SparrowDB builds.

## A `RETURN` alias on a node scan reads the wrong property, or null

In a plain `MATCH (n:Label) … RETURN`, the engine resolves each property column by its
**output name**, not by the expression you projected:

| Query | Result |
|---|---|
| `MATCH (k:Knowledge) RETURN k.id` | correct |
| `MATCH (k:Knowledge) RETURN k.id AS id` | correct: the alias equals the property name |
| `MATCH (k:Knowledge) RETURN k.id AS zzz` | `null` |
| `MATCH (k:Knowledge) RETURN k.id AS contentType` | **silently returns `k.contentType`** |

Projecting anything that materializes the node restores correct resolution: `id(k)`,
`labels(k)`, or the bare variable `k`, in any position. Relationship-expansion projections
(`MATCH (a)-[r:T]->(b) RETURN a.id AS f`) are unaffected.

**Rule for new queries: project properties unaliased, or alias them to their own property
name.** `_ensureInternalIdMap` is safe because it projects `id(k)`.

Reproduction: `npx jest src/__tests__/SparrowDBBinding.reads.test.ts` runs 15 assertions against
a real throwaway DB.

## Claims that were WRONG. Do not reintroduce them

- ~~"Reads return `null` unless `id(k)` is projected first."~~ Verified false 2026-07-31 on a
  scratch DB and on a copy of `~/.kms-sparrowdb-v2`. `MATCH (k) RETURN k.id` and
  `MATCH (k) RETURN id(k), k.id` return **identical** values: 2542 rows, 2497 non-null, and
  the same 45 nulls either way. Those 45 are genuinely property-less orphan nodes (internal
  ids 168–214, payload `{col_0: 0}`). This claim is the alias defect above, seen through an
  aliased query and blamed on the wrong cause.
- ~~"SparrowDB truncates string properties to 7 characters on read."~~ False, verified three
  ways: a scratch DB, a copy of the live store, and the exact query
  `GraphEdgeIndex.readEdges()` issues, which returns whole 36-char UUIDs on both endpoints.
  This non-problem cost a prefix-matching resolver in `SparrowDBStorage` (since removed) and
  two invalid review findings on PR #87.
- ~~"`npm ci` silently breaks vector support."~~ True only for 0.1.20/0.1.21. See above.
