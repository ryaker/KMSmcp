#!/usr/bin/env bash
set -euo pipefail
# Build sparrowdb-node NAPI binary and copy to npm/sparrowdb/sparrowdb.node
# Usage: bash scripts/build-sparrowdb-node.sh [path-to-SparrowDB-repo]

SPARROW_DIR="${1:-${SPARROWDB_DIR:-$HOME/Dev/SparrowDB}}"

if [[ ! -d "$SPARROW_DIR" ]]; then
  echo "❌ SparrowDB repo not found at: $SPARROW_DIR"
  echo "   Set SPARROWDB_DIR env var or pass path as first argument"
  exit 1
fi

echo "🦀 Building sparrowdb-node from: $SPARROW_DIR"
cd "$SPARROW_DIR"
cargo build --release -p sparrowdb-node

# macOS: .dylib → .node
if [[ -f target/release/libsparrowdb_node.dylib ]]; then
  cp target/release/libsparrowdb_node.dylib npm/sparrowdb/sparrowdb.node
elif [[ -f target/release/sparrowdb_node.dll ]]; then
  cp target/release/sparrowdb_node.dll npm/sparrowdb/sparrowdb.node
else
  # Linux .so
  cp target/release/libsparrowdb_node.so npm/sparrowdb/sparrowdb.node
fi

SIZE=$(ls -lh npm/sparrowdb/sparrowdb.node | awk '{print $5}')
echo "✅ sparrowdb.node rebuilt: $SIZE"
echo "   Path: $SPARROW_DIR/npm/sparrowdb/sparrowdb.node"
