# Unified KMS MCP Server - AI Assistant Quick Reference

## Project Context

You are implementing a Unified Knowledge Management System (KMS) MCP Server that treats databases as "AI brain memory" rather than traditional data storage. This system intelligently routes knowledge to Mem0 (semantic memory), Neo4j (relationships), or MongoDB (structured data) while maintaining sub-100ms response times.

## Key Differences from Traditional Approaches

❌ **NOT THIS**: `query → database → result → done`  
✅ **THIS**: `memory → learns → evolves → builds relationships → grows smarter`

## Core Implementation Files

```
/Volumes/Dev/localDev/KMSmcp/
├── src/
│   ├── index.ts                    # Main MCP server entry
│   ├── types/index.ts              # Core TypeScript types
│   ├── cache/FACTCache.ts          # 3-layer caching (L1: memory, L2: Redis, L3: DB)
│   ├── routing/IntelligentStorageRouter.ts  # AI-powered storage decisions
│   ├── storage/
│   │   ├── Mem0Storage.ts          # Semantic/personal memories
│   │   ├── Neo4jStorage.ts         # Knowledge relationships
│   │   └── MongoDBStorage.ts       # Structured data
│   └── tools/
│       ├── UnifiedStoreTool.ts     # Main storage interface
│       └── UnifiedSearchTool.ts    # Cross-system search
└── docs/
    └── IMPLEMENTATION_GUIDE.md     # Full implementation details
```

## Quick Implementation Checklist

### Phase 1: Connection Pooling (Inspired by genai-toolbox)
```typescript
// Pre-warm connections for sub-100ms performance
class MemoryConnectionPool {
  mem0Pool: Mem0Connection[] = [];    // Min: 3, Max: 10
  neo4jPool: Neo4jSession[] = [];     // Min: 2, Max: 8
  mongoPool: MongoClient[] = [];      // Min: 3, Max: 10
}
```

### Phase 2: Intelligent Routing
```typescript
// Content examples → Storage decision
"Client prefers morning sessions" → Mem0 (behavioral memory)
"Technique X helped with anxiety" → Neo4j (cause-effect relationship)
"Session duration: 60 minutes" → MongoDB (configuration data)
```

### Phase 3: Memory Evolution
- Auto-link related memories (e.g., "OAuth fix" → previous "OAuth debugging")
- Create "lesson learned" from repeated patterns
- Build knowledge graphs automatically

### Phase 4: Context Switching
```typescript
// Like genai-toolbox "toolsets" but for memory contexts
contexts = {
  'personal_development': { cache: 'L1', systems: ['mem0', 'neo4j'] },
  'coaching_session': { cache: 'L2', systems: ['mem0', 'mongodb', 'neo4j'] }
}
```

## Key Patterns from genai-toolbox to Adopt

1. **Connection Pooling** → Apply to Mem0/Neo4j/MongoDB
2. **SDK Design** → Clean client interface
3. **Observability** → OpenTelemetry for memory health
4. **Declarative Config** → Base patterns with AI override

## Testing Your Implementation

```typescript
// Example test: Verify intelligent routing
const memory = await client.remember(
  "Finally solved the OAuth redirect issue!"
);
assert(memory.primaryStorage === 'mem0');        // Personal breakthrough
assert(memory.secondaryStorage.includes('neo4j')); // Create relationships
```

## Performance Targets

- **Response Time**: 95% under 100ms
- **Cache Hit Rate**: >80% for L1 (personal queries)
- **Memory Evolution**: >10% create relationships
- **Routing Accuracy**: >90% correct storage decisions

## Common Pitfalls to Avoid

1. ❌ Don't treat this like a database wrapper
2. ❌ Don't skip the connection pooling (critical for performance)
3. ❌ Don't hardcode routing rules (use patterns + AI override)
4. ❌ Don't forget memory evolution (the "learning" part)

## Environment Variables Needed

```bash
MEM0_API_KEY=your_mem0_key
NEO4J_URI=neo4j://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_password
MONGODB_URI=mongodb://admin:password@localhost:27017
REDIS_URL=redis://localhost:6379
```

## Quick Commands

```bash
# Development
npm run dev                    # Start with hot reload
npm test                      # Run test suite
npm run test:performance      # Verify sub-100ms

# Docker
docker-compose up -d          # Start all services
docker-compose logs -f        # Watch logs
```

## Success Indicators

✅ Memories automatically link to related knowledge  
✅ Cache warms on startup with frequent memories  
✅ Context switching changes routing behavior  
✅ Observability shows healthy connection pools  
✅ Evolution engine creates new insights  

## Remember

This is NOT a database tool - it's an AI memory system that learns and evolves. Every feature should support the vision of memories that grow smarter over time.

---

**Full details**: See `/Volumes/Dev/localDev/KMSmcp/docs/IMPLEMENTATION_GUIDE.md`
