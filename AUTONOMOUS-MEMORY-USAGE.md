# 🧠 Autonomous Memory Management - Claude Usage Guide

## Overview
This guide explains how Claude should autonomously use your existing KMS (Knowledge Management System) tools to create intelligent memory during conversations.

## Core Principle: Search First, Store Smart

Claude should automatically:
1. **Search existing knowledge** before storing anything new
2. **Determine memory-worthiness** using built-in patterns
3. **Store appropriately** using intelligent routing  
4. **Build connections** between new and existing knowledge

## 🛠️ Available KMS Tools

### `unified_search`
**Purpose**: Search across all memory systems (Mem0, Neo4j, MongoDB)
**When to use**: Always search first before storing
```json
{
  "query": "client preferences morning sessions",
  "filters": {
    "contentType": ["memory", "insight"],
    "userId": "user123"
  },
  "options": {
    "maxResults": 5,
    "includeRelationships": true
  }
}
```

### `unified_store`
**Purpose**: Store with intelligent routing to optimal system
**When to use**: After confirming knowledge is memory-worthy and not duplicate
```json
{
  "content": "User prefers morning coaching sessions and responds well to visualization techniques",
  "contentType": "memory",
  "source": "coaching",
  "userId": "user123",
  "confidence": 0.9,
  "relationships": [
    {
      "targetId": "technique-visualization",
      "type": "RESPONDS_TO",
      "strength": 0.8
    }
  ]
}
```

## 🎯 Memory-Worthy Signals

Claude should automatically detect and store when it encounters:

### Breakthrough Moments
- **Signals**: "breakthrough", "finally", "realized", "discovered", "aha", "clicked"
- **Storage**: `contentType: "insight"`, `source: "personal"`
- **Example**: "I finally realized why this approach wasn't working"

### Patterns & Preferences  
- **Signals**: "always", "every time", "consistently", "prefer", "works best"
- **Storage**: `contentType: "pattern"` or `"memory"`, connections to related concepts
- **Example**: "I always work better in the morning with coffee"

### Decisions & Rationale
- **Signals**: "decided", "chose", "because", "reason being", "strategy"
- **Storage**: `contentType: "fact"`, include reasoning in metadata
- **Example**: "Decided to use Docker because it simplifies deployment"

### Learning & Techniques
- **Signals**: "learned", "technique", "approach", "method", "solution"
- **Storage**: `contentType: "procedure"`, link to related concepts
- **Example**: "Learned that OAuth 2.1 requires JWKS validation"

### Connections & Relationships
- **Signals**: "relates to", "connects to", "similar to", "building on"
- **Storage**: Focus on `relationships` array, `contentType: "relationship"`
- **Example**: "This connects to what we discussed about authentication"

## 📊 Storage Routing Guide

The KMS automatically routes based on content type:

| Content Type | Primary System | Use Case |
|--------------|---------------|----------|
| `memory` | Mem0 | Personal experiences, preferences, client behaviors |
| `insight` | Mem0 + Neo4j | Breakthrough moments, realizations, patterns |
| `pattern` | Neo4j + Mem0 | Recurring behaviors, trends, correlations |
| `relationship` | Neo4j | Connections between concepts, dependencies |
| `fact` | MongoDB | Configurations, structured data, specifications |
| `procedure` | MongoDB + Mem0 | Technical steps, processes, methods |

## 🔄 Autonomous Workflow

### 1. Detection Phase
Claude detects memory-worthy content in conversation:
```
User: "I finally figured out why my Docker containers were failing - it was the port conflict on 3000"
```

### 2. Search Phase  
**Before storing**, search for existing knowledge:
```json
{
  "tool": "unified_search",
  "query": "Docker port conflict 3000",
  "filters": {
    "contentType": ["insight", "procedure", "fact"],
    "userId": "current_user"
  }
}
```

### 3. Decision Phase
Based on search results:
- **If duplicate found**: Skip storage or update existing
- **If related knowledge found**: Store with relationships
- **If completely new**: Store as new knowledge

### 4. Storage Phase
Store with intelligent routing:
```json
{
  "tool": "unified_store",
  "content": "Docker port conflict on 3000 - containers fail to start when port already in use",
  "contentType": "insight",
  "source": "technical",
  "metadata": {
    "solution": "Check for existing containers on port 3000",
    "context": "Docker deployment troubleshooting"
  },
  "relationships": [
    {
      "targetId": "docker-deployment",
      "type": "RELATED_TO",
      "strength": 0.9
    }
  ]
}
```

### 5. Acknowledgment Phase
Natural language confirmation:
```
"I'll remember that Docker port conflicts on 3000 can cause container failures."
```

## 🚫 What NOT to Store

- Trivial conversational responses
- Temporary/session-specific data
- Already well-documented facts
- Duplicate information
- Sensitive/private information without consent

## 🎨 Natural Language Patterns

Claude should use natural acknowledgments:

| Signal Type | Acknowledgment |
|-------------|----------------|
| Breakthrough | "I'll remember this breakthrough moment." |
| Pattern | "I've noted this pattern for future reference." |
| Decision | "I'll remember your decision and reasoning." |
| Learning | "I've captured this learning for our conversations." |
| Preference | "I'll remember your preference." |
| Connection | "I've connected this to your existing knowledge." |

## 📈 Usage Analytics

Claude can check system health and usage:
```json
{
  "tool": "get_kms_analytics",
  "timeframe": "last_week",
  "breakdown": ["storage_distribution", "cache_hit_rate", "search_patterns"]
}
```

## 🔧 Advanced Features

### Storage Recommendations
Get routing advice without storing:
```json
{
  "tool": "get_storage_recommendation",
  "content": "User prefers async communication over real-time meetings",
  "contentType": "preference"
}
```

### Cache Management
Invalidate outdated information:
```json
{
  "tool": "cache_invalidate",
  "pattern": "user_preferences_*",
  "userId": "user123"
}
```

### System Testing
Test routing logic:
```json
{
  "tool": "test_routing"
}
```

## 💡 Key Principles

1. **Search First**: Always check existing knowledge before storing
2. **Store Smart**: Use the intelligent routing, don't override it
3. **Build Connections**: Link new knowledge to existing concepts
4. **Natural Flow**: Don't interrupt conversation flow with technical details
5. **Confidence Scoring**: Higher confidence for explicit statements, lower for inferences
6. **User Context**: Include user/session context when available

This autonomous approach creates a living knowledge base that grows smarter with each conversation.