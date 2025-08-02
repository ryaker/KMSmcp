# Unified KMS MCP Server - Implementation Guide

## Overview

This document provides implementation instructions for building a Unified Knowledge Management System (KMS) MCP Server that treats data as evolving AI memory rather than static database queries. The system intelligently routes knowledge to optimal storage systems (Mem0, Neo4j, MongoDB) while maintaining sub-100ms response times through FACT caching.

## Core Philosophy

**Key Distinction**: Unlike traditional database tools (e.g., genai-toolbox), this system treats data as neural memory that:
- Evolves and learns from interactions
- Builds relationships between concepts
- Maintains context across sessions
- Grows smarter over time

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   MCP Client (Claude, etc)              │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│              Unified KMS MCP Server                     │
│  ┌─────────────────────────────────────────────────┐  │
│  │            FACT Cache Layer (L1/L2/L3)          │  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────┐  │
│  │         Intelligent Storage Router              │  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────┐  │
│  │           Memory Connection Pool                │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                    │         │         │
                    ▼         ▼         ▼
            ┌─────────┐ ┌─────────┐ ┌─────────┐
            │  Mem0   │ │  Neo4j  │ │ MongoDB │
            └─────────┘ └─────────┘ └─────────┘
```

## Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)

#### 1.1 Connection Pool Implementation

Create a connection pool manager that pre-warms connections to all memory systems:

```typescript
// src/connection/MemoryConnectionPool.ts
interface PoolConfig {
  mem0: { minConnections: 3, maxConnections: 10 };
  neo4j: { minConnections: 2, maxConnections: 8 };
  mongodb: { minConnections: 3, maxConnections: 10 };
}

class MemoryConnectionPool {
  // Implementation requirements:
  // - Pre-warm connections on startup
  // - Health check every 30 seconds
  // - Automatic reconnection on failure
  // - Connection metrics for observability
}
```

**Key Implementation Points:**
- Use connection pooling patterns from genai-toolbox but adapted for memory systems
- Implement exponential backoff for reconnection attempts
- Track connection metrics: utilization, latency, errors

#### 1.2 FACT Cache Enhancement

Enhance the existing FACT cache with connection pool awareness:

```typescript
// src/cache/EnhancedFACTCache.ts
class EnhancedFACTCache extends FACTCache {
  // Additional features:
  // - Cache warming for frequent queries (richard_yaker memories)
  // - Predictive cache loading based on access patterns
  // - Memory pressure management
  // - Cache coherence across distributed instances
}
```

**Cache Warming Strategy:**
- On startup, pre-load frequently accessed memories
- Track access patterns and adjust cache warming
- Use bloom filters for efficient existence checks

### Phase 2: Intelligent Routing System (Week 2-3)

#### 2.1 Pattern-Based Router Enhancement

Enhance the intelligent router with declarative patterns + AI override:

```typescript
// src/routing/PatternBasedRouter.ts
interface MemoryPattern {
  name: string;
  pattern: RegExp;
  signals: string[]; // Keywords that strengthen this pattern
  primaryStorage: StorageType;
  secondaryStorage?: StorageType[];
  cacheStrategy: 'L1' | 'L2' | 'L3';
  evolutionRules: EvolutionRule[];
}

const DEFAULT_PATTERNS: MemoryPattern[] = [
  {
    name: 'breakthrough_moment',
    pattern: /breakthrough|finally|realized|discovered/i,
    signals: ['aha', 'eureka', 'solved'],
    primaryStorage: 'mem0',
    secondaryStorage: ['neo4j'],
    cacheStrategy: 'L1',
    evolutionRules: [
      { action: 'create_relationship', type: 'led_to' },
      { action: 'tag_category', value: 'breakthrough' }
    ]
  },
  {
    name: 'technical_learning',
    pattern: /learned|understood|implemented|fixed/i,
    signals: ['because', 'by', 'through'],
    primaryStorage: 'mem0',
    secondaryStorage: ['mongodb'],
    cacheStrategy: 'L2',
    evolutionRules: [
      { action: 'extract_cause_effect' },
      { action: 'link_to_projects' }
    ]
  },
  {
    name: 'configuration_data',
    pattern: /config|setting|parameter|option/i,
    signals: ['value', 'equals', 'set to'],
    primaryStorage: 'mongodb',
    cacheStrategy: 'L3',
    evolutionRules: [
      { action: 'version_track' }
    ]
  }
];
```

**Router Implementation Requirements:**
- Pattern matching with confidence scoring
- AI override capability when patterns don't match well
- Learning mechanism to improve patterns over time
- Telemetry to track routing decisions

#### 2.2 Memory Context System

Implement context switching inspired by genai-toolbox's toolsets:

```typescript
// src/context/MemoryContextManager.ts
interface MemoryContext {
  name: string;
  description: string;
  activeStorageSystems: StorageType[];
  routingPatterns: MemoryPattern[];
  cacheStrategy: CacheStrategy;
  evolutionRules: EvolutionRule[];
  metrics: ContextMetrics;
}

const CONTEXTS: Record<string, MemoryContext> = {
  'personal_development': {
    name: 'Personal Development',
    description: 'Richard Yaker personal learning and breakthroughs',
    activeStorageSystems: ['mem0', 'neo4j'],
    routingPatterns: [/* specific patterns for personal context */],
    cacheStrategy: {
      defaultTTL: 300, // 5 minutes for personal queries
      maxSize: '100MB',
      evictionPolicy: 'LRU'
    },
    evolutionRules: [
      { action: 'track_learning_path' },
      { action: 'identify_breakthrough_patterns' }
    ]
  },
  'coaching_session': {
    name: 'Coaching Session',
    description: 'Active coaching with client memory',
    activeStorageSystems: ['mem0', 'mongodb', 'neo4j'],
    // ... coaching-specific configuration
  }
};
```

### Phase 3: Memory Evolution System (Week 3-4)

#### 3.1 Memory Evolution Engine

Implement automatic memory evolution and relationship building:

```typescript
// src/evolution/MemoryEvolutionEngine.ts
interface EvolutionRule {
  name: string;
  trigger: EvolutionTrigger;
  action: EvolutionAction;
  conditions?: EvolutionCondition[];
}

class MemoryEvolutionEngine {
  // Features to implement:
  // - Automatic relationship discovery
  // - Memory consolidation (merge similar memories)
  // - Temporal decay (reduce cache priority for old, unused memories)
  // - Cross-reference building
  // - Pattern extraction from memory clusters
}
```

**Evolution Examples:**
- When storing "Fixed OAuth issue", link to previous "OAuth troubleshooting" memories
- When detecting repeated patterns, create a "lesson learned" memory
- When memories conflict, create a "revision" relationship

#### 3.2 Cross-System Synchronization

Implement synchronization between storage systems:

```typescript
// src/sync/CrossSystemSync.ts
class CrossSystemSynchronizer {
  // Sync strategies:
  // - Eventual consistency for non-critical data
  // - Strong consistency for user preferences
  // - Conflict resolution based on timestamps + confidence
  
  async syncMemory(memoryId: string, source: StorageType) {
    // 1. Read from source system
    // 2. Transform for target systems
    // 3. Write to secondary storage with backpressure
    // 4. Update sync metadata
  }
}
```

### Phase 4: SDK and Client Libraries (Week 4)

#### 4.1 Core SDK Design

Create a clean SDK inspired by genai-toolbox's pattern:

```typescript
// packages/unified-kms-core/src/client.ts
export class UnifiedKMSClient {
  constructor(
    private url: string,
    private options?: ClientOptions
  ) {}

  // Core memory operations
  async remember(
    content: string,
    context?: string,
    metadata?: Record<string, any>
  ): Promise<Memory> {
    // Intelligent storage with routing
  }

  async recall(
    query: string,
    options?: RecallOptions
  ): Promise<Memory[]> {
    // Cross-system search with ranking
  }

  async evolve(
    memoryId: string,
    evolution: EvolutionRequest
  ): Promise<Memory> {
    // Update and create relationships
  }

  // Context management
  async setContext(contextName: string): Promise<void> {
    // Switch memory context
  }

  // Bulk operations
  async bulkRemember(
    memories: BulkMemoryRequest[]
  ): Promise<BulkMemoryResponse> {
    // Efficient batch storage
  }
}
```

#### 4.2 Framework-Specific Adapters

Create adapters for popular frameworks:

```python
# packages/unified-kms-langchain/src/memory.py
from langchain.memory import BaseMemory
from unified_kms import UnifiedKMSClient

class UnifiedKMSMemory(BaseMemory):
    """LangChain-compatible memory using Unified KMS"""
    
    def __init__(self, client: UnifiedKMSClient, context: str = "default"):
        self.client = client
        self.context = context
    
    async def add_memory(self, input_str: str, output_str: str):
        # Store conversation with intelligent routing
        
    async def get_relevant_memories(self, query: str) -> List[str]:
        # Retrieve with FACT caching
```

### Phase 5: Observability and Metrics (Week 5)

#### 5.1 Memory Health Metrics

Implement comprehensive observability:

```typescript
// src/metrics/MemoryHealthMetrics.ts
interface MemoryMetrics {
  // Connection health (from genai-toolbox pattern)
  connectionPoolUtilization: Gauge;
  connectionLatency: Histogram;
  connectionErrors: Counter;
  
  // Memory-specific metrics
  memoryEvolutionRate: Gauge; // memories evolved per minute
  relationshipDensity: Gauge; // avg relationships per memory
  contextSwitchLatency: Histogram;
  memoryRelevanceScore: Gauge; // based on recall frequency
  
  // Cache effectiveness
  cacheHitRate: Gauge;
  cacheEvictionRate: Counter;
  cacheSizeBytes: Gauge;
  
  // Storage distribution
  storageDistribution: {
    mem0: Gauge;
    neo4j: Gauge;
    mongodb: Gauge;
  };
}
```

#### 5.2 OpenTelemetry Integration

```typescript
// src/metrics/TelemetryProvider.ts
class TelemetryProvider {
  // Implement OpenTelemetry for:
  // - Distributed tracing across memory operations
  // - Metrics export to Prometheus/Grafana
  // - Structured logging with trace correlation
  // - Custom dashboards for memory health
}
```

## Configuration Management

### Environment Configuration

```yaml
# config/default.yaml
server:
  port: 5000
  host: 0.0.0.0

connection_pools:
  mem0:
    min_connections: 3
    max_connections: 10
    connection_timeout: 5000
    health_check_interval: 30000
  neo4j:
    min_connections: 2
    max_connections: 8
  mongodb:
    min_connections: 3
    max_connections: 10

cache:
  l1:
    max_size: 100MB
    ttl: 300 # 5 minutes
  l2:
    max_size: 1GB
    ttl: 1800 # 30 minutes
  l3:
    max_size: 10GB
    ttl: 3600 # 1 hour

routing:
  ai_override_threshold: 0.7 # Use AI if pattern confidence < 0.7
  pattern_learning_enabled: true
  pattern_update_interval: 86400 # Daily

evolution:
  enabled: true
  batch_size: 100
  processing_interval: 60000 # 1 minute
```

## Testing Strategy

### Unit Tests
- Test each storage adapter independently
- Mock external dependencies
- Test routing logic with various content patterns
- Verify cache behavior under different scenarios

### Integration Tests
- Test full memory storage flow
- Verify cross-system synchronization
- Test context switching
- Validate evolution rules

### Performance Tests
- Verify sub-100ms response times
- Test connection pool under load
- Measure cache effectiveness
- Stress test with concurrent operations

### Example Test:
```typescript
describe('UnifiedKMSClient', () => {
  it('should route breakthrough memories to Mem0 with Neo4j secondary', async () => {
    const client = new UnifiedKMSClient('http://localhost:5000');
    
    const memory = await client.remember(
      'Finally discovered the issue with OAuth - it was the redirect URI!',
      'debugging'
    );
    
    expect(memory.primaryStorage).toBe('mem0');
    expect(memory.secondaryStorage).toContain('neo4j');
    expect(memory.relationships).toContainEqual({
      type: 'breakthrough',
      category: 'technical'
    });
  });
});
```

## Deployment Considerations

### Docker Compose Configuration
```yaml
version: '3.8'
services:
  unified-kms:
    build: .
    ports:
      - "5000:5000"
    environment:
      - MEM0_API_KEY=${MEM0_API_KEY}
      - NEO4J_URI=${NEO4J_URI}
      - MONGODB_URI=${MONGODB_URI}
    depends_on:
      - redis
      
  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
```

### Production Checklist
- [ ] Connection string encryption
- [ ] API authentication implementation
- [ ] Rate limiting
- [ ] Backup strategy for each storage system
- [ ] Monitoring and alerting setup
- [ ] Graceful shutdown handling
- [ ] Memory pressure management

## Success Metrics

1. **Performance**: 95% of requests under 100ms
2. **Reliability**: 99.9% uptime
3. **Memory Evolution**: >10% of memories create relationships
4. **Cache Effectiveness**: >80% cache hit rate for L1
5. **Context Accuracy**: >90% correct storage routing

## Next Steps for Implementers

1. Start with Phase 1 (Connection Pool + Enhanced Cache)
2. Build comprehensive unit tests alongside implementation
3. Deploy locally with docker-compose for development
4. Implement phases iteratively with working software at each phase
5. Gather metrics early to validate architectural decisions

## Additional Resources

- Original KMS architecture: `/Volumes/Dev/Work/CoachingClone`
- Modular implementation: `/Volumes/Dev/localDev/KMSmcp/src`
- Mem0 integration guide: Memory ID `76100ac4-896e-488b-90ad-036c0dfaaa80`
- genai-toolbox patterns: https://github.com/googleapis/genai-toolbox

---

Remember: The goal is not just to store data, but to create an evolving AI memory that learns and grows smarter with each interaction.
