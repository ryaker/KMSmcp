# Unified KMS Technical Specification: genai-toolbox Pattern Adoption

## Executive Summary

This specification details how to adopt architectural patterns from Google's genai-toolbox while maintaining our vision of AI memory that evolves rather than static database queries.

## Pattern Analysis & Adoption Strategy

### 1. Connection Pool Architecture

#### genai-toolbox Pattern
```go
// Their approach: Database connection pooling
type ConnectionPool struct {
    maxConnections int
    minConnections int
    connections    []DatabaseConnection
}
```

#### Our Adaptation for Memory Systems
```typescript
interface MemoryConnectionPool {
  // Connection pools for each memory system
  pools: {
    mem0: {
      connections: Mem0Client[];
      config: {
        min: 3,  // Always keep 3 warm for richard_yaker queries
        max: 10,
        warmupQueries: ['user_id:richard_yaker', 'context:personal_development']
      }
    },
    neo4j: {
      connections: Neo4jDriver[];
      config: {
        min: 2,
        max: 8,
        warmupQueries: ['MATCH (n:Knowledge) RETURN n LIMIT 1']
      }
    },
    mongodb: {
      connections: MongoClient[];
      config: {
        min: 3,
        max: 10,
        warmupQueries: [{ database: 'kms', collection: 'system_architecture' }]
      }
    }
  };
  
  // Health monitoring
  healthCheck(): Promise<PoolHealth>;
  
  // Intelligent connection allocation
  getConnection(storageType: StorageType, priority: Priority): Promise<Connection>;
}
```

**Key Enhancements:**
- Warmup queries specific to memory patterns
- Priority-based connection allocation
- Memory-aware health checks

### 2. Tool Organization → Memory Contexts

#### genai-toolbox Pattern
```yaml
toolsets:
  analytics_tools:
    - query_sales_data
    - generate_report
```

#### Our Memory Context System
```typescript
interface MemoryContextSystem {
  contexts: {
    'personal_development': {
      description: 'Richard Yaker learning and breakthroughs',
      memorySystemPriority: ['mem0', 'neo4j'],  // Order matters
      routingHints: {
        keywords: ['breakthrough', 'learned', 'realized'],
        preferredStorage: 'mem0',
        relationshipBuilding: 'aggressive'
      },
      cacheStrategy: {
        layer: 'L1',
        ttl: 300,  // 5 min
        preloadPatterns: ['user_id:richard_yaker AND type:breakthrough']
      }
    },
    'coaching_session': {
      description: 'Active coaching with client',
      memorySystemPriority: ['mem0', 'mongodb', 'neo4j'],
      routingHints: {
        keywords: ['client', 'session', 'technique'],
        preferredStorage: 'distributed',  // Use all systems
        relationshipBuilding: 'moderate'
      },
      cacheStrategy: {
        layer: 'L2',
        ttl: 1800,  // 30 min
        preloadPatterns: ['type:coaching_insight']
      }
    }
  };
  
  // Context switching
  switchContext(contextName: string): Promise<void>;
  getCurrentContext(): MemoryContext;
  
  // Context-aware routing
  routeWithContext(content: string): StorageDecision;
}
```

### 3. SDK Design Pattern

#### genai-toolbox Pattern
```python
client = ToolboxClient(url)
tools = client.load_toolset("analytics")
result = tools.execute("query_sales", params)
```

#### Our Memory-Focused SDK
```typescript
// Core SDK with memory semantics
class UnifiedKMSClient {
  // Memory operations (not CRUD)
  async remember(content: string, options?: RememberOptions): Promise<Memory>;
  async recall(query: string, options?: RecallOptions): Promise<Memory[]>;
  async evolve(memoryId: string, evolution: Evolution): Promise<Memory>;
  async forget(memoryId: string, reason?: string): Promise<void>;
  
  // Relationship operations
  async connect(memory1: string, memory2: string, relationship: Relationship): Promise<void>;
  async explore(startMemory: string, depth: number): Promise<KnowledgeGraph>;
  
  // Context management
  async setContext(context: string): Promise<void>;
  async getContextHistory(): Promise<ContextSwitch[]>;
  
  // Bulk operations with intelligence
  async bulkRemember(memories: Memory[], options?: BulkOptions): Promise<BulkResult>;
  async consolidate(timeRange: TimeRange): Promise<ConsolidationResult>;
}

// Framework adapters
class LangChainKMSMemory extends BaseMemory {
  constructor(private kmsClient: UnifiedKMSClient) {}
  
  async saveContext(input: string, output: string) {
    // Intelligent extraction and storage
    const insights = await this.extractInsights(input, output);
    await this.kmsClient.bulkRemember(insights);
  }
}
```

### 4. Observability & Metrics

#### genai-toolbox Pattern
- Query latency
- Connection pool usage
- Error rates

#### Our Memory Health Metrics
```typescript
interface MemoryHealthMetrics {
  // Connection health (adopted from genai-toolbox)
  connections: {
    poolUtilization: Gauge;      // Per storage system
    connectionLatency: Histogram;
    connectionErrors: Counter;
    warmupEffectiveness: Gauge;  // How often warmup helped
  };
  
  // Memory-specific metrics
  memory: {
    evolutionRate: Gauge;        // Memories evolved/minute
    relationshipDensity: Gauge;  // Avg connections per memory
    recallRelevance: Histogram;  // Score distribution
    contextSwitchLatency: Histogram;
    memoryAge: Histogram;        // Age distribution
  };
  
  // Intelligence metrics
  routing: {
    decisionAccuracy: Gauge;     // Correct routing %
    aiOverrideRate: Counter;     // How often AI overrides patterns
    patternEffectiveness: Map<string, Gauge>;  // Per pattern
  };
  
  // Cache effectiveness
  cache: {
    hitRate: Map<'L1' | 'L2' | 'L3', Gauge>;
    warmupHitRate: Gauge;        // Hits from pre-warmed data
    evictionRate: Counter;
    memorySizeBytes: Gauge;
  };
}
```

### 5. Configuration Management

#### genai-toolbox Pattern
```yaml
sources:
  postgres:
    host: localhost
tools:
  query_users:
    source: postgres
```

#### Our Intelligent Configuration
```yaml
# Base configuration with AI override capability
memory_systems:
  mem0:
    connection:
      api_key: ${MEM0_API_KEY}
      base_url: ${MEM0_URL}
    defaults:
      enable_graph: true
      user_id: richard_yaker  # Default for personal KMS
      
  neo4j:
    connection:
      uri: ${NEO4J_URI}
      auth:
        user: ${NEO4J_USER}
        password: ${NEO4J_PASSWORD}
    defaults:
      create_backlinks: true
      
  mongodb:
    connection:
      uri: ${MONGODB_URI}
    defaults:
      database: kms
      
routing_patterns:
  # Declarative patterns that AI can override
  - name: breakthrough_moment
    pattern: 'breakthrough|finally|realized|discovered'
    confidence_threshold: 0.8
    primary: mem0
    secondary: [neo4j]
    cache: L1
    
  - name: technical_config
    pattern: 'config|setting|parameter'
    confidence_threshold: 0.7
    primary: mongodb
    cache: L3

evolution_rules:
  - name: link_breakthroughs
    trigger: 'new_memory_with_pattern:breakthrough_moment'
    action: 'find_similar_and_link'
    
  - name: extract_lessons
    trigger: 'pattern_repeated:3_times'
    action: 'create_lesson_learned'

# Performance tuning
performance:
  connection_pools:
    warmup_on_startup: true
    health_check_interval: 30s
    
  cache:
    warmup_patterns:
      - 'user_id:richard_yaker'
      - 'type:breakthrough'
      - 'context:personal_development'
    
  routing:
    ai_override_threshold: 0.7  # Use AI if confidence < 0.7
    pattern_learning: true
    pattern_update_interval: 24h
```

## Implementation Priority

### Phase 1: Foundation (Must Have)
1. Connection pooling with warmup
2. Basic routing patterns
3. Simple caching (L1 only)

### Phase 2: Intelligence (Should Have)  
1. AI routing override
2. Memory evolution engine
3. Multi-layer caching (L1/L2/L3)

### Phase 3: Advanced (Nice to Have)
1. Pattern learning from usage
2. Predictive cache warming
3. Cross-system relationship mapping

## Testing Strategy Inspired by genai-toolbox

### Connection Pool Tests
```typescript
describe('MemoryConnectionPool', () => {
  it('should maintain minimum connections', async () => {
    const pool = new MemoryConnectionPool(config);
    await pool.initialize();
    
    expect(pool.getPoolStats().mem0.active).toBeGreaterThanOrEqual(3);
    expect(pool.getPoolStats().neo4j.active).toBeGreaterThanOrEqual(2);
  });
  
  it('should handle connection failures gracefully', async () => {
    // Simulate Mem0 outage
    mockMem0.failNext(3);
    
    const memory = await client.remember('Test memory');
    expect(memory.primaryStorage).toBe('mongodb'); // Fallback
    expect(memory.degraded).toBe(true);
  });
});
```

### Performance Benchmarks
```typescript
describe('Performance', () => {
  it('should achieve sub-100ms for cached queries', async () => {
    // Warm cache
    await client.recall('breakthrough OAuth');
    
    // Measure
    const start = performance.now();
    const memories = await client.recall('breakthrough OAuth');
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(100);
  });
});
```

## Migration Path from Current Architecture

1. **Week 1**: Add connection pooling to existing MCP servers
2. **Week 2**: Implement unified server with basic routing
3. **Week 3**: Migrate personal KMS (richard_yaker) as pilot
4. **Week 4**: Add evolution engine and advanced features
5. **Week 5**: Full production deployment

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Response Time (P95) | <100ms | OpenTelemetry |
| Cache Hit Rate (L1) | >80% | Redis metrics |
| Memory Evolution Rate | >10% | Custom gauge |
| Connection Pool Efficiency | >70% | Pool metrics |
| Routing Accuracy | >90% | A/B testing |

---

Remember: We're not building a database tool. We're building an AI memory system that learns and evolves. Every pattern we adopt from genai-toolbox should enhance this vision.
