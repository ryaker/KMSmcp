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
## 🔍 SemTools - Semantic Filesystem for Document Intelligence

### Overview
SemTools provides semantic search and document parsing capabilities, transforming Claude Code into a general document intelligence agent beyond just code.

### Components
- **`parse`** - Converts non-searchable documents (PDFs, DOCX, PPTX, etc.) to markdown using LlamaParse API
- **`search`** - Local semantic keyword search using multilingual embeddings (no cloud dependency)
- **`workspace`** - Persistent caching for blazing-fast repeated searches

### Installation & Configuration
```bash
# Already installed globally via npm
# API key configured in ~/.zshrc
export LLAMA_CLOUD_API_KEY="REDACTED_API_KEY"
```

### Common Usage Patterns

#### Basic Parse and Search
```bash
# Parse PDFs and search for specific content
parse document.pdf | xargs cat | search "error handling" --n-lines 30

# Search across multiple parsed documents
parse my_docs/*.pdf | xargs search "API endpoints" --n-lines 30 --max-distance 0.3

# Direct search on text files
search "machine learning" *.txt --n-lines 30 --top-k 10
```

#### Using Workspaces for Large Collections
```bash
# Create/use a workspace for persistent indexing
workspace use my-workspace
export SEMTOOLS_WORKSPACE=my-workspace

# Initial search (creates index)
search "financial analysis" docs/*.pdf --n-lines 30 --top-k 10

# Subsequent searches use cached embeddings (MUCH faster)
search "quarterly earnings" docs/*.pdf --n-lines 30 --max-distance 0.3

# Check workspace status
workspace status

# Clean up stale files
workspace prune
```

#### Advanced Pipelines
```bash
# Combine with grep for precise filtering
parse *.pdf | xargs cat | grep -i "revenue" | search "Q3 2024" --max-distance 0.2

# Multi-stage pipeline
find . -name "*.pdf" -mtime -30 | xargs parse | xargs search "compliance" --n-lines 50

# Parse and create searchable knowledge base
parse reports/*.pdf contracts/*.docx | tee parsed_files.txt | xargs search "liability clause" --n-lines 40
```

### Best Practices for Claude Code

1. **Always use workspaces** for repeated searches over the same files
2. **Set --n-lines to 30-50** for adequate context (default 3 is too small)
3. **Use --ignore-case** flag for case-insensitive search
4. **Parse first** when dealing with PDFs, Word docs, or other non-text formats
5. **Combine --max-distance and --top-k** for optimal results
6. **Cache parsed files** - they're stored in ~/.parse/ automatically

### Use Cases

- **Financial Analysis**: Parse quarterly reports, search for specific metrics
- **Legal Review**: Search contracts for specific clauses semantically
- **Research Synthesis**: Analyze academic papers, extract methodologies
- **Technical Documentation**: Find info across mixed format docs
- **Knowledge Mining**: Create searchable indexes of company documents

### Tips

- Parsed files are cached in `~/.parse/` - reuse them!
- Workspaces are stored in `~/.semtools/workspaces/`
- Use `--max-distance 0.3` for semantic similarity (lower = more similar)
- Use `--top-k` when you want a fixed number of results
- Combine with standard Unix tools (grep, awk, sed) for powerful pipelines

