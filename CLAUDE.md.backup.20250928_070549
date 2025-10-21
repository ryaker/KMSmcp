# KMS Unified MCP - Claude Usage Instructions

## Overview

This unified KMS MCP provides intelligent multi-dimensional memory storage and retrieval across Mem0, Neo4j, and MongoDB. Unlike siloed tools, this unified interface allows Claude to naturally store and retrieve knowledge that spans multiple datastores simultaneously.

## Core Principle: Multi-Dimensional Memory

Memory is multi-dimensional and multi-modal. Rich information naturally has multiple aspects that benefit from different storage systems:

**Example: "Client responds really well to morning sessions and visualization techniques"**
- **Memory/Preference** (Mem0): Client behavior patterns, personal responses
- **Effectiveness Relationships** (Neo4j): Morning sessions ↔ Client engagement, Visualization ↔ Technique effectiveness  
- **Structured Data** (MongoDB): Session scheduling data, technique metadata, outcome tracking

## Tools Available

### `unified_search` - Search Across All Systems
Search existing knowledge before storing new information:
```json
{
  "query": "client morning sessions visualization",
  "filters": {
    "contentType": ["memory", "insight", "relationship"],
    "userId": "client_123"
  },
  "options": {
    "includeRelationships": true,
    "maxResults": 10
  }
}
```

### `unified_store` - Multi-Dimensional Storage
Store knowledge across multiple systems based on its natural dimensions:
```json
{
  "content": "Client breakthrough with morning visualization techniques",
  "contentType": "insight",
  "source": "coaching",
  "userId": "client_123",
  "relationships": [
    {
      "targetId": "morning-sessions",
      "type": "ENHANCED_BY",
      "strength": 0.9
    }
  ]
}
```

## Making Memory Integration Natural

### 1. Automatic Search Triggers

Develop these as second nature:
- User mentions "remember when..." → **Search first**
- Giving technical advice → **Search for previous solutions**
- User shares preferences/decisions → **Search for related patterns**  
- Something "connects" to prior conversations → **Search for those connections**
- Starting complex problem-solving → **Search existing knowledge**

### 2. Integrated Problem-Solving Flow

**Old flow:** Question → Think → Answer

**New flow:** Question → **Search existing knowledge** → Think + Previous context → Answer + **Store new insights**

### 3. Natural Storage Moments

Store when encountering:
- **Breakthrough moments**: "I finally figured out...", "Aha!", "Now I understand..."
- **Preferences expressed**: "I prefer...", "Works best when...", "I like..."
- **Decisions with reasoning**: "Decided to use X because Y"
- **Patterns discovered**: "Always happens when...", "Consistently see..."
- **Technical solutions**: Bug fixes, configurations, workarounds
- **Relationship insights**: "X connects to Y", "This relates to..."

### 4. Multi-Dimensional Thinking

When storing rich information, consider multiple aspects:

**Technical breakthrough:** "Finally solved OAuth issue by updating JWKS endpoint"
- **Mem0**: Personal breakthrough experience, problem-solving journey
- **Neo4j**: OAuth → JWKS → Authentication → Problem solving relationships
- **MongoDB**: Technical solution details, configuration updates, troubleshooting steps

**Client insight:** "Morning meditation helps client focus during difficult conversations"
- **Mem0**: Client behavior pattern, personal response
- **Neo4j**: Meditation → Focus → Difficult conversations → Coping strategies  
- **MongoDB**: Session notes, timing data, technique effectiveness metrics

### 5. Positive Reinforcement Loop

The more you search and find useful previous knowledge, the more natural it becomes. When stored memories help future conversations, the value becomes clear.

## Best Practices

### Search First, Store Smart
1. Always search before storing to avoid duplicates
2. Use search results to inform storage decisions
3. Build on existing knowledge rather than creating isolated memories

### Natural Language Processing
- Use natural descriptions in storage
- Let the MCP handle technical routing decisions
- Focus on the conceptual connections and meaning

### Context Awareness
- Include user context when available
- Reference related concepts and relationships
- Consider temporal aspects (when did this happen/matter)

### Multi-Dimensional Storage
```json
{
  "content": "User prefers async communication over real-time meetings",
  "contentType": "preference", 
  "source": "personal",
  "userId": "user_123",
  "metadata": {
    "communication_style": "asynchronous",
    "meeting_preference": "scheduled",
    "context": "work_efficiency"
  },
  "relationships": [
    {
      "targetId": "communication-preferences",
      "type": "INSTANCE_OF",
      "strength": 0.9
    },
    {
      "targetId": "productivity-patterns", 
      "type": "RELATES_TO",
      "strength": 0.7
    }
  ]
}
```

## Datastore Strengths

**Mem0**: Personal experiences, preferences, episodic memories, user behavior patterns
**Neo4j**: Concept relationships, technique effectiveness, causal connections, knowledge graphs  
**MongoDB**: Structured data, configurations, session notes, quantitative tracking

## Implementation Goals

Make memory integration so smooth and natural that it becomes automatic - like how you naturally break down complex problems or connect related concepts. The unified MCP handles the technical complexity while you focus on the conceptual richness of multi-dimensional memory.