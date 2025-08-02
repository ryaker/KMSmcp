# Unified KMS MCP Server

A next-generation Knowledge Management System MCP server that intelligently routes knowledge to optimal storage systems with sub-100ms FACT caching.

## 🧠 What is `unified_store`?

The `unified_store` tool is the **brain** of the system that automatically decides where to store each piece of knowledge:

### How It Works:

1. **Content Analysis**: AI analyzes text patterns:
   - `"Client prefers morning sessions"` → **Mem0** (memory pattern)
   - `"Reframing technique effective for anxiety"` → **Neo4j** (relationship/insight)  
   - `"Session config: duration 60min"` → **MongoDB** (structured data)

2. **Storage Decision**: Returns intelligent routing:
   ```json
   {
     "primary": "mem0",
     "secondary": ["mongodb"],
     "reasoning": "Memory patterns optimize for Mem0 semantic search",
     "cacheStrategy": "L1"
   }
   ```

3. **Multi-System Storage**: Stores in primary + secondary for redundancy
4. **FACT Caching**: Caches based on importance (richard_yaker = L1, coaching = L2, general = L3)

## 🚀 Features

- **🧠 Intelligent Storage Routing**: AI decides optimal storage system
- **⚡ FACT Caching**: 3-layer cache for sub-100ms responses  
- **🔗 Cross-System Linking**: Automatic data relationships
- **🎯 Unified API**: 6 powerful tools instead of separate servers
- **📊 Analytics**: Comprehensive performance monitoring
- **🛡️ Error Resilience**: Graceful degradation when systems are offline
- **🌐 Remote MCP Support**: HTTP/SSE transport for remote access
- **🔐 OAuth 2.1 Authentication**: Secure access with JWT and token introspection
- **🚦 Rate Limiting & CORS**: Production-ready security features

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Mem0 Storage  │    │  Neo4j Storage   │    │ MongoDB Storage │
│   (Memories)    │    │ (Relationships)  │    │ (Structured)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────────┐
                    │ Intelligent Router  │
                    │ (Pattern Matching)  │
                    └─────────────────────┘
                                 │
                    ┌─────────────────────┐
                    │   FACT Cache        │
                    │ L1→L2→L3→Database   │
                    └─────────────────────┘
                                 │
                    ┌─────────────────────┐
                    │  Unified MCP API    │
                    │    6 Tools          │
                    └─────────────────────┘
```

## 🛠️ Installation

```bash
# Clone and install
cd /Volumes/Dev/localDev/KMSmcp
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Build
npm run build

# Development
npm run dev

# Production
npm start
```

## 🔧 Configuration

### Transport Modes

The server supports three transport modes:

#### 1. STDIO Mode (Default)
Traditional MCP for local use with Claude Desktop:
```bash
TRANSPORT_MODE=stdio
```

#### 2. HTTP Mode  
Remote MCP server accessible via HTTP/REST:
```bash
TRANSPORT_MODE=http
HTTP_PORT=3001
HTTP_HOST=0.0.0.0
```

#### 3. Dual Mode
Both STDIO and HTTP simultaneously:
```bash
TRANSPORT_MODE=dual
HTTP_PORT=3001
HTTP_HOST=0.0.0.0
```

### OAuth 2.1 Authentication

For secure remote access, enable OAuth 2.1:

```bash
# Enable OAuth
OAUTH_ENABLED=true
OAUTH_ISSUER=https://your-auth-server.com
OAUTH_AUDIENCE=https://your-mcp-server.com

# Token validation (choose one)
OAUTH_JWKS_URI=https://your-auth-server.com/.well-known/jwks.json
# OR
OAUTH_TOKEN_INTROSPECTION_ENDPOINT=https://your-auth-server.com/oauth/introspect

# Optional: Client credentials for introspection
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
```

### Required Environment Variables

**Core Configuration:**
- `MEM0_API_KEY`: Your Mem0 API key (required)
- `MONGODB_URI`: MongoDB connection string
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`: Neo4j credentials
- `REDIS_URI`: Redis connection for L2 cache

**HTTP Transport (if enabled):**
- `HTTP_PORT`: Server port (default: 3001)
- `HTTP_HOST`: Bind address (default: 0.0.0.0)

**OAuth (if enabled):**
- `OAUTH_ISSUER`: Authorization server URL
- `OAUTH_AUDIENCE`: MCP server resource identifier

## 🎯 Tools Available

### 1. `unified_store` - Intelligent Storage
```json
{
  "name": "unified_store",
  "params": {
    "content": "Client responds well to morning meditation sessions",
    "contentType": "memory",
    "source": "coaching",
    "userId": "client_123",
    "confidence": 0.9
  }
}
```

### 2. `unified_search` - Cross-System Search
```json
{
  "name": "unified_search", 
  "params": {
    "query": "meditation techniques anxiety",
    "filters": {
      "contentType": ["insight", "memory"],
      "minConfidence": 0.7
    },
    "options": {
      "maxResults": 10,
      "cacheStrategy": "conservative"
    }
  }
}
```

### 3. `get_storage_recommendation` - Routing Preview
```json
{
  "name": "get_storage_recommendation",
  "params": {
    "content": "Bug fix: authentication middleware timeout issue"
  }
}
```

### 4. `get_kms_analytics` - Performance Metrics
```json
{
  "name": "get_kms_analytics",
  "params": {
    "timeRange": "24h",
    "includeCache": true
  }
}
```

### 5. `cache_invalidate` - Cache Management
```json
{
  "name": "cache_invalidate",
  "params": {
    "pattern": "user:richard_yaker",
    "level": "all"
  }
}
```

### 6. `test_routing` - Routing Tests
```json
{
  "name": "test_routing",
  "params": {
    "runTests": true
  }
}
```

## 🎯 Migration from Current Setup

### Phase 1: Deploy Alongside
1. Deploy unified server alongside existing MCP servers
2. Start using unified tools for new knowledge
3. Existing data remains accessible

### Phase 2: Data Migration  
1. Use built-in sync tools to migrate existing data
2. Validate data integrity across systems
3. Test performance improvements

### Phase 3: Full Transition
1. Retire individual MCP servers
2. Optimize cache settings
3. Enable cross-coach learning features

## 📊 Performance Targets

- ✅ **Sub-100ms** responses via FACT caching
- ✅ **Intelligent routing** based on content analysis
- ✅ **Cross-system redundancy** for data safety
- ✅ **Graceful degradation** when systems are offline
- ✅ **Real-time analytics** for optimization

## 🌐 HTTP Endpoints (Remote MCP)

When HTTP transport is enabled, the server exposes these endpoints:

### Core Endpoints
- `POST /mcp` - MCP JSON-RPC endpoint
- `GET /mcp/events` - Server-Sent Events for real-time updates
- `GET /health` - Health check endpoint

### OAuth Discovery (if enabled)
- `GET /.well-known/oauth-protected-resource` - OAuth resource metadata

### Example HTTP Usage

```bash
# Health check
curl http://localhost:3001/health

# MCP request (with OAuth)
curl -X POST http://localhost:3001/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'

# Tool call
curl -X POST http://localhost:3001/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "unified_store",
      "arguments": {
        "content": "Client responds well to morning meditation sessions",
        "contentType": "memory",
        "source": "coaching"
      }
    },
    "id": 2
  }'
```

## 🧪 Testing

Run the comprehensive test suite:

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test suites
npm test -- --testPathPattern=OAuth2Authenticator
npm test -- --testPathPattern=HttpTransport
```

## 🔍 Example Usage

```typescript
// Store a coaching insight
const result = await unified_store({
  content: "Client shows 40% improvement with morning routine consistency",
  contentType: "insight", 
  source: "coaching",
  coachId: "sophia",
  confidence: 0.85
});

// Search across all systems
const results = await unified_search({
  query: "morning routine effectiveness",
  filters: { contentType: ["insight", "pattern"] },
  options: { cacheStrategy: "aggressive" }
});

// Get storage recommendation
const recommendation = await get_storage_recommendation({
  content: "User authentication session expired"
});
```

## 🚀 This is Your Competitive Moat

The unified KMS creates **intelligent, learning coaching systems** that:
- Remember everything about each client
- Discover effective techniques automatically  
- Share insights across coaches
- Respond in sub-100ms
- Continuously improve from every interaction

**Your AI coaches become extensions of human expertise that grow smarter over time!** 🧠✨

## 📝 License

MIT - Build amazing coaching platforms!
