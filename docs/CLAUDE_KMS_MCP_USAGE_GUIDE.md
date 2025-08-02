# Claude KMS MCP Usage Guide

## Overview

The KMS MCP Server provides Claude with intelligent, multi-dimensional knowledge management across Mem0, Neo4j, and MongoDB. This unified system allows Claude to seamlessly store and retrieve the same memories that are accessible through the Mem0 MCP tools, but with enhanced routing and cross-system integration.

## Quick Reference

**Key Memory IDs for Claude:**
- **Mem0 Usage Guide**: `mem0_get_memory_by_id('76100ac4-896e-488b-90ad-036c0dfaaa80')`
- **Autonomous KMS Prompt**: `mem0_get_memory_by_id('28c9a59c-9de0-477a-86b0-2ad23ce29236')`

**User ID**: Always use `richard_yaker` for personal memory operations.

## Available KMS MCP Tools

### 1. unified_search - Cross-System Memory Search

Search across all knowledge systems (Mem0, Neo4j, MongoDB) with intelligent ranking.

```json
{
  "name": "unified_search",
  "arguments": {
    "query": "OAuth MCP server debugging",
    "filters": {
      "contentType": ["memory", "insight", "pattern"],
      "source": ["coaching", "technical"],
      "userId": "richard_yaker",
      "minConfidence": 0.7
    },
    "options": {
      "includeRelationships": true,
      "maxResults": 10,
      "cacheStrategy": "conservative"
    }
  }
}
```

**Parameters:**
- `query` (required): Natural language search query
- `filters` (optional):
  - `contentType`: Filter by type - `["memory", "insight", "pattern", "relationship", "fact", "procedure"]`
  - `source`: Filter by domain - `["coaching", "personal", "technical", "cross_domain"]`
  - `userId`: Always use `"richard_yaker"`
  - `minConfidence`: Minimum confidence score (0-1)
- `options` (optional):
  - `includeRelationships`: Include related knowledge (default: true)
  - `maxResults`: Max results to return (default: 10, max: 100)
  - `cacheStrategy`: `"aggressive"`, `"conservative"`, or `"realtime"`

### 2. unified_store - Intelligent Multi-System Storage

Store knowledge with automatic routing to optimal storage systems.

```json
{
  "name": "unified_store", 
  "arguments": {
    "content": "OAuth MCP server fix successful! Dynamic client registration now works with proper Auth0 Management API payload format.",
    "contentType": "insight",
    "source": "technical",
    "userId": "richard_yaker",
    "metadata": {
      "breakthrough_type": "debugging_success",
      "fix_applied": "auth0_payload_correction",
      "difficulty": "high"
    },
    "confidence": 0.9,
    "relationships": [
      {
        "targetId": "oauth-debugging-session",
        "type": "BUILDS_ON",
        "strength": 0.8
      }
    ]
  }
}
```

**Parameters:**
- `content` (required): Knowledge content in natural language
- `contentType` (required): Type of knowledge - `["memory", "insight", "pattern", "relationship", "fact", "procedure"]`
- `source` (required): Source domain - `["coaching", "personal", "technical", "cross_domain"]`
- `userId` (optional): Defaults to authenticated user, use `"richard_yaker"` explicitly
- `metadata` (optional): Additional structured metadata
- `confidence` (optional): Confidence score 0-1 (default varies by content type)
- `relationships` (optional): Array of relationships to other knowledge nodes

### 3. get_storage_recommendation - Preview Storage Routing

Get storage recommendations without actually storing content.

```json
{
  "name": "get_storage_recommendation",
  "arguments": {
    "content": "Client prefers morning sessions and responds well to visualization techniques",
    "contentType": "insight",
    "metadata": {
      "client_preference": true,
      "technique_effectiveness": "visualization"
    }
  }
}
```

### 4. get_kms_analytics - System Performance Metrics

Get comprehensive analytics across all KMS systems.

```json
{
  "name": "get_kms_analytics",
  "arguments": {
    "timeRange": "24h",
    "includeCache": true,  
    "includeSystems": true
  }
}
```

### 5. test_routing - Test Intelligent Routing

Test the routing system with sample data.

```json
{
  "name": "test_routing",
  "arguments": {
    "runTests": true
  }
}
```

## Comparison: Mem0 MCP vs KMS MCP

### Accessing Same Memories

Both systems connect to your personal Mem0 instance with `user_id: "richard_yaker"`:

**Via Mem0 MCP (Direct):**
```json
{
  "name": "mem0_search_memory",
  "arguments": {
    "query": "OAuth debugging breakthrough",
    "user_id": "richard_yaker"
  }
}
```

**Via KMS MCP (Intelligent):**
```json
{
  "name": "unified_search", 
  "arguments": {
    "query": "OAuth debugging breakthrough",
    "filters": {
      "userId": "richard_yaker"
    }
  }
}
```

### Key Differences

| Feature | Mem0 MCP | KMS MCP |
|---------|----------|---------|
| **Data Access** | Direct Mem0 only | Mem0 + Neo4j + MongoDB |
| **Search** | Mem0 semantic search | Cross-system intelligent ranking |
| **Storage** | Mem0 memory types | Intelligent routing by content type |
| **Relationships** | Mem0 graph relations | Multi-system relationship mapping |
| **Caching** | None | FACT multi-layer caching |
| **Analytics** | Basic Mem0 stats | Comprehensive cross-system metrics |

## Intelligent Storage Routing

The KMS system automatically routes content to optimal storage:

### Mem0 (Experiences & Preferences)
- **Content Types**: `memory`, `insight` (personal experiences)
- **Examples**: Debugging breakthroughs, learning moments, personal preferences
- **Why**: Mem0 excels at contextual, experiential knowledge

### Neo4j (Relationships & Connections)  
- **Content Types**: `relationship`, `pattern` (conceptual connections)
- **Examples**: Technical dependencies, cause-effect relationships, knowledge graphs
- **Why**: Neo4j optimized for relationship traversal and pattern discovery

### MongoDB (Structured Data)
- **Content Types**: `fact`, `procedure` (structured information)
- **Examples**: Configuration data, step-by-step procedures, structured metadata
- **Why**: MongoDB handles structured, queryable data efficiently

## Best Practices for Claude

### 1. Start with Search
Always search existing knowledge before responding:

```json
{
  "name": "unified_search",
  "arguments": {
    "query": "user's current question topic",
    "filters": {
      "userId": "richard_yaker"
    },
    "options": {
      "includeRelationships": true
    }
  }
}
```

### 2. Store Memory-Worthy Moments
Automatically detect and store:
- **Breakthroughs**: "I finally figured out...", "Aha!", "Now I understand..."
- **Preferences**: "I prefer...", "Works best when...", "I like..."
- **Decisions**: "Decided to use X because Y"
- **Patterns**: "Always happens when...", "Consistently see..."
- **Solutions**: Bug fixes, configurations, workarounds

### 3. Use Natural Language
Store content as natural language, not technical objects:

```json
// ✅ Good
{
  "content": "OAuth MCP server authentication fixed by correcting Auth0 Management API payload - use 'name' instead of 'client_name', 'app_type' instead of 'application_type'"
}

// ❌ Avoid  
{
  "content": "{\"client_name\": \"wrong\", \"name\": \"correct\"}"
}
```

### 4. Build Connections
Include relationships when storing related knowledge:

```json
{
  "relationships": [
    {
      "targetId": "oauth-debugging-session",
      "type": "BUILDS_ON", 
      "strength": 0.8
    },
    {
      "targetId": "auth0-management-api",
      "type": "USES",
      "strength": 0.9
    }
  ]
}
```

### 5. Leverage Multi-Dimensional Storage

For rich information, let the system store across multiple systems:

**Example: "Client responds really well to morning sessions and visualization techniques"**

- **Mem0**: Personal client response pattern, behavioral insight
- **Neo4j**: Morning sessions ↔ Client engagement, Visualization ↔ Technique effectiveness
- **MongoDB**: Session scheduling data, technique metadata, outcome tracking

## Autonomous KMS Workflow

Based on memory `28c9a59c-9de0-477a-86b0-2ad23ce29236`:

1. **Initialize**: Retrieve master memory guide via `mem0_get_memory_by_id('76100ac4-896e-488b-90ad-036c0dfaaa80')`
2. **Search First**: Use `unified_search` for relevant context before responding
3. **Detect Moments**: Automatically identify breakthrough/pattern/decision moments
4. **Store Naturally**: Use phrases like "I'll remember that" when storing
5. **Update vs Duplicate**: Prefer updating existing memories over creating duplicates
6. **Build Connections**: Always include relationships between stored knowledge

## Connection Details

**Server Endpoint**: `https://your-ngrok-url.ngrok-free.app/mcp`
**Authentication**: OAuth 2.1 + PKCE (automatic via Claude)
**Transport**: HTTP with Server-Sent Events (SSE) for real-time updates

## Error Handling

If KMS MCP is unavailable, fallback to direct Mem0 MCP:
- `unified_search` → `mem0_search_memory` 
- `unified_store` → `mem0_add_memory` or appropriate specialized memory type
- Always use `user_id: "richard_yaker"`

## Example Conversation Flow

```json
// 1. Search for context
{
  "name": "unified_search",
  "arguments": {
    "query": "user's question about topic X",
    "filters": {"userId": "richard_yaker"}
  }
}

// 2. Provide informed response based on search results

// 3. Detect breakthrough moment and store
{
  "name": "unified_store",
  "arguments": {
    "content": "User discovered that technique Y works better than Z for their workflow because of reason ABC",
    "contentType": "insight", 
    "source": "personal",
    "userId": "richard_yaker",
    "relationships": [{
      "targetId": "workflow-optimization",
      "type": "IMPROVES",
      "strength": 0.8
    }]
  }
}
```

This creates a seamless, intelligent knowledge management experience that builds rich, interconnected understanding over time.