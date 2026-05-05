#!/usr/bin/env bash
set -euo pipefail
# Build sparrowdb-node NAPI binary + regenerate TypeScript surface, then propagate
# both into KMSmcp's node_modules/sparrowdb/.
#
# Why both targets matter:
#   - SparrowDB's npm/sparrowdb/sparrowdb.node is the source-of-truth for any
#     downstream that uses `file:../SparrowDB/npm/sparrowdb` as a dep.
#   - KMSmcp currently consumes `sparrowdb@^0.1.20` from npm. The published
#     tarball ships a Linux-ELF sparrowdb.node that fails to load on darwin-arm64,
#     so we overwrite node_modules/sparrowdb/sparrowdb.node directly.
#
# napi-cli (declared in SparrowDB's npm/sparrowdb/devDependencies) does the
# cargo build AND the .d.ts gen in one invocation; output is named
# index.<platform>.node, which we then copy as sparrowdb.node.
#
# Usage: bash scripts/build-sparrowdb-node.sh [path-to-SparrowDB-repo]

SPARROW_DIR="${1:-${SPARROWDB_DIR:-$HOME/Dev/SparrowDB}}"
KMSMCP_NODE_MODULES="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/node_modules/sparrowdb"

if [[ ! -d "$SPARROW_DIR" ]]; then
  echo "❌ SparrowDB repo not found at: $SPARROW_DIR"
  echo "   Set SPARROWDB_DIR env var or pass path as first argument"
  exit 1
fi

if [[ ! -d "$KMSMCP_NODE_MODULES" ]]; then
  echo "❌ KMSmcp's sparrowdb is not installed at: $KMSMCP_NODE_MODULES"
  echo "   Run 'npm install' in KMSmcp first."
  exit 1
fi

NAPI_BIN="$SPARROW_DIR/npm/sparrowdb/node_modules/.bin/napi"
if [[ ! -x "$NAPI_BIN" ]]; then
  echo "🔧 @napi-rs/cli not installed in SparrowDB. Installing once…"
  (cd "$SPARROW_DIR/npm/sparrowdb" && npm install)
fi

echo "🦀 Building sparrowdb-node (cargo + .d.ts) from: $SPARROW_DIR"
(cd "$SPARROW_DIR/npm/sparrowdb" && rm -f index.*.node && \
  ./node_modules/.bin/napi build --release --platform \
    --dts index.d.ts --js false \
    --cargo-cwd ../../crates/sparrowdb-node \
    --cargo-name sparrowdb_node)

# napi-rs 2.18.4 PascalCase-converts struct `SparrowDB` to `SparrowDb` in factory
# return types. The class declaration is correct (`SparrowDB`), but
# `static open(...): SparrowDb` references an undefined symbol → TS compile
# fails for consumers. Repair on every regen until upstream napi-rs lands a fix.
# perl (not BSD sed) for portable \b word boundary.
perl -i -pe 's/\bSparrowDb\b/SparrowDB/g' "$SPARROW_DIR/npm/sparrowdb/index.d.ts"

# napi emits index.<platform>.node — find it and normalize to sparrowdb.node.
NATIVE_OUT=$(ls "$SPARROW_DIR/npm/sparrowdb/"index.*.node 2>/dev/null | head -1)
if [[ -z "$NATIVE_OUT" ]]; then
  echo "❌ napi build did not produce an index.*.node artifact"
  exit 1
fi
cp "$NATIVE_OUT" "$SPARROW_DIR/npm/sparrowdb/sparrowdb.node"

echo "📦 Propagating to KMSmcp node_modules…"
cp "$SPARROW_DIR/npm/sparrowdb/sparrowdb.node" "$KMSMCP_NODE_MODULES/sparrowdb.node"
cp "$SPARROW_DIR/npm/sparrowdb/index.d.ts"     "$KMSMCP_NODE_MODULES/index.d.ts"

SIZE=$(ls -lh "$SPARROW_DIR/npm/sparrowdb/sparrowdb.node" | awk '{print $5}')
DTS_LINES=$(wc -l < "$SPARROW_DIR/npm/sparrowdb/index.d.ts" | tr -d ' ')
NEW_API_REFS=$(grep -c 'hybridSearch\|vectorSearch\|fulltextSearch' "$KMSMCP_NODE_MODULES/index.d.ts" || true)
echo "✅ Done."
echo "   sparrowdb.node: $SIZE  (also copied to KMSmcp)"
echo "   index.d.ts: $DTS_LINES lines  (also copied to KMSmcp)"
echo "   New API refs (hybridSearch/vectorSearch/fulltextSearch) in KMSmcp's index.d.ts: $NEW_API_REFS"
