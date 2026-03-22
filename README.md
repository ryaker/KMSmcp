# KMS MCP — Unified Knowledge Management System

A polyglot memory server built on the [Model Context Protocol](https://modelcontextprotocol.io). Intelligently routes knowledge across Neo4j, Mem0, and MongoDB, surfaces it through semantic search with sub-100ms FACT caching, and exposes everything as MCP tools for Claude Desktop, Claude Code, and any MCP-compatible client.

---

## Why polyglot memory?

Different knowledge has different shapes:

| Layer | Store | Strength |
|-------|-------|----------|
| Knowledge graph | Neo4j | Entities, typed edges, traversal queries — *who worked where, what connects to what* |
| Semantic / episodic | Mem0 | Natural language recall, personal context, "do I know anything about X?" |
| Structured documents | MongoDB | Config, procedures, technical specs — exact field queries |

**The routing rule is simple:** Neo4j + Mem0 always (graph + semantic layer). MongoDB added only for procedural or technical content. You don't choose — the router chooses.

---

## Architecture

```
Input
  │
  ▼
┌─────────────────────────────────┐
│  Content Inference              │  Detects type, source, tags
│  (ContentInference.ts)          │
└─────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────┐
│  Storage Router                 │  LLM (Ollama) → regex fallback
│  OllamaStorageRouter            │
│  IntelligentStorageRouter       │
└─────────────────────────────────┘
  │
  ├──────────────────────┬─────────────────────────┐
  ▼                      ▼                         ▼
Neo4j              Mem0 (always)         MongoDB (if technical/
(always)           Semantic + episodic   procedural content)
Knowledge graph    memory layer
  │
  ▼
┌─────────────────────────────────┐
│  EnrichmentQueue (async)        │  Entity extraction, graph linking
│  EntityLinker + OllamaInference │  via local Ollama (optional)
└─────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────┐
│  FACT Cache                     │  L1 (in-memory) → L2 (Redis) → L3
│  3-layer, sub-100ms             │
└─────────────────────────────────┘
  │
  ▼
MCP Tools  /  HTTP API  /  CLI
```

---

## Prerequisites

Four cloud services. All have free tiers.

| Service | Purpose | Get it |
|---------|---------|--------|
| [Mem0](https://mem0.ai) | Semantic / episodic memory | Free tier, API key from dashboard |
| [Neo4j Aura](https://neo4j.com/cloud/aura/) | Knowledge graph | Free tier, 50k nodes |
| [MongoDB Atlas](https://mongodb.com/atlas) | Structured documents | Free 512MB cluster |
| [Redis Cloud](https://redis.com/redis-cloud/) or [Upstash](https://upstash.com/) | L2 cache (optional) | Free tiers available |

**Optional:** [Ollama](https://ollama.com) running locally for LLM-powered routing. Falls back gracefully to regex routing if unavailable.

---

## Installation

```bash
git clone https://github.com/ryaker/KMSmcp
cd KMSmcp
npm install
npm run build
```

### Environment variables

```bash
# Storage
MEM0_API_KEY=your_mem0_api_key
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/kms
NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password
REDIS_URI=redis://...          # Optional — L2 cache

# Identity
KMS_DEFAULT_USER_ID=your_user_id   # e.g. "alice" — stored with all knowledge

# Transport
TRANSPORT_MODE=http            # stdio | http | dual
HTTP_PORT=8180
HTTP_HOST=0.0.0.0

# LLM routing (optional — improves routing quality)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b

# OAuth (optional)
OAUTH_ENABLED=false
OAUTH_ISSUER=https://your-auth-server.com
OAUTH_JWKS_URI=https://your-auth-server.com/.well-known/jwks.json
```

### Start the server

```bash
# Development
npm run dev

# Production
npm start

# With Doppler (recommended for secret management)
doppler run -- npm start
```

---

## Client configuration

### Claude Code

```json
{
  "mcpServers": {
    "kms": {
      "type": "http",
      "url": "https://your-kms-server/mcp"
    }
  }
}
```

For local use:
```json
{
  "mcpServers": {
    "kms": {
      "type": "http",
      "url": "http://localhost:8180/mcp"
    }
  }
}
```

### Claude Desktop

Settings → MCP Connectors → Add custom connector → enter your server URL.

### Transport modes

| Mode | Use case |
|------|----------|
| `stdio` | Local Claude Desktop, no network |
| `http` | Remote access via Cloudflare Tunnel, Railway, etc. |
| `dual` | Both simultaneously |

---

## MCP Tools

### `unified_store` — Store knowledge

```json
{
  "content": "Resolved OAuth loop by pinning jwks-rsa to 3.1.0 — later versions break with Auth0",
  "contentType": "procedure",
  "source": "technical",
  "confidence": 0.95
}
```

```json
{
  "content": "I work best with async-first communication — real-time meetings drain focus",
  "contentType": "memory",
  "source": "personal"
}
```

**`contentType`:** `memory` | `insight` | `pattern` | `relationship` | `fact` | `procedure`
**`source`:** `personal` | `technical` | `cross_domain`

The router always targets Neo4j + Mem0. MongoDB is added automatically for `procedure`, `technical` source, or config-pattern content.

### `unified_search` — Search across all systems

```json
{
  "query": "OAuth authentication issues",
  "filters": {
    "contentType": ["procedure", "fact"],
    "minConfidence": 0.7
  },
  "options": {
    "maxResults": 10,
    "cacheStrategy": "conservative"
  }
}
```

Results are merged, deduplicated, and ranked across Neo4j, Mem0, and MongoDB. Entity relationships surfaced from the graph layer.

### `get_storage_recommendation` — Preview routing without storing

```json
{
  "content": "Deploy via GitHub Actions to Azure Static Web App on push to main"
}
```

Returns the routing decision (primary + secondary stores, cache strategy, reasoning) without writing anything.

### `kms_ping` — Health check

Returns status of all three storage systems and the cache layer. Use to verify connectivity before storing.

### `get_kms_analytics` — Performance metrics

```json
{
  "timeRange": "24h",
  "includeCache": true
}
```

### `cache_invalidate` — Invalidate cache entries

```json
{
  "pattern": "user:alice",
  "level": "all"
}
```

### `kms_instructions` — Usage guide

Returns the KMS CLAUDE.md instructions as a tool response — useful for grounding agents at the start of a session.

---

## CLI (agent / shell use)

For Claude Code agents and shell scripts that don't have an MCP client. Mirrors the MCP tools exactly.

```bash
# Install globally after build
npm link

# Store knowledge
doppler run -- kms store "Resolved the Neo4j timeout by setting connection pool to 50" \
  --type procedure --source technical

# Search
doppler run -- kms search "Neo4j connection issues" --limit 5

# Preview routing (no secrets needed)
kms route "npm install --save-dev typescript" --type procedure

# Health check all three stores
doppler run -- kms ping
```

**Commands:** `store` | `search` | `ping` | `route`

---

## Routing in detail

### Decision flow

1. **Ollama LLM** (if available, confidence ≥ 0.6) — best signal, understands semantics
2. **Regex fallback** — pattern matching on content + contentType + source

### Routing rules

| Content | Neo4j | Mem0 | MongoDB |
|---------|-------|------|---------|
| Any knowledge | ✅ always | ✅ always | — |
| `contentType: procedure` | ✅ | ✅ | ✅ |
| `source: technical` | ✅ | ✅ | ✅ |
| Config / deploy / API patterns | ✅ | ✅ | ✅ |

### Cache strategy

| Source | Level | TTL |
|--------|-------|-----|
| `personal` | L1 | 5 min (in-memory) |
| `memory` / `insight` contentType | L2 | 30 min (Redis) |
| High confidence (>0.8) | L2 | 30 min |
| `technical` / `procedure` | L3 | 1 hour (Redis) |

---

## Async enrichment (optional)

After storing, the `EnrichmentQueue` runs asynchronously if Ollama is available:

1. Extracts entity mentions from stored content
2. Matches against existing Neo4j nodes via `EntityLinker`
3. Creates typed relationships in the graph automatically

This builds the knowledge graph incrementally without blocking the store operation. If Ollama is unavailable, enrichment is skipped silently.

---

## HTTP endpoints

```
POST /mcp           MCP JSON-RPC endpoint
GET  /mcp           SSE stream (resumable sessions)
DELETE /mcp         Close session
GET  /health        Health check
GET  /.well-known/oauth-protected-resource/mcp   OAuth metadata (if enabled)
GET  /.well-known/oauth-authorization-server     OAuth metadata (if enabled)
```

```bash
# Health
curl http://localhost:8180/health

# Tool call
curl -X POST http://localhost:8180/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "unified_store",
      "arguments": {
        "content": "Always add connection timeout to Neo4j driver config",
        "contentType": "procedure",
        "source": "technical"
      }
    },
    "id": 1
  }'
```

---

## OAuth 2.1 (optional)

```bash
OAUTH_ENABLED=true
OAUTH_ISSUER=https://your-auth-server.com
OAUTH_AUDIENCE=https://your-kms-server.com
OAUTH_JWKS_URI=https://your-auth-server.com/.well-known/jwks.json

# Or token introspection
OAUTH_TOKEN_INTROSPECTION_ENDPOINT=https://your-auth-server.com/oauth/introspect
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
```

MCP discovery methods (`initialize`, `tools/list`) are allowed without authentication for protocol compatibility.

---

## SparrowDB Backend (Local Graph)

KMS supports SparrowDB as a local, zero-latency alternative to Neo4j Aura.

### Prerequisites

- [SparrowDB](https://github.com/ryaker/SparrowDB) cloned locally (default: `~/Dev/SparrowDB`)
- Rust stable toolchain

### Build the NAPI binary

```bash
# From KMSmcp root:
npm run build:sparrowdb

# Or directly:
bash scripts/build-sparrowdb-node.sh [/path/to/SparrowDB]
```

### Import from Neo4j

```bash
SPARROWDB_PATH=~/.kms-sparrowdb \
doppler run --project ry-local --config dev_personal -- \
  node scripts/import-neo4j-to-sparrowdb.mjs
```

### Start KMS with SparrowDB backend

```bash
SPARROWDB_PATH=~/.kms-sparrowdb \
KMS_STORAGE_BACKEND=sparrowdb \
doppler run --project ry-local --config dev_personal -- npm run dev
```

### Shadow mode (Neo4j primary + SparrowDB diff logging)

```bash
KMS_SHADOW_MODE=true \
SPARROWDB_PATH=~/.kms-sparrowdb \
doppler run --project ry-local --config dev_personal -- npm run dev
```

---

## Testing

```bash
npm test
npm run test:coverage
npm test -- --testPathPattern=OAuth2Authenticator
npm test -- --testPathPattern=HttpTransport
```

---

## License

MIT
