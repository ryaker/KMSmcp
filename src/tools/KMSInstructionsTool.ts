/**
 * KMS Instructions Tool - Provides guidance on autonomous KMS usage
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js'

export class KMSInstructionsTool {
  name = 'kms_instructions'
  description = 'Get instructions on how to autonomously use the Knowledge Management System effectively'

  getTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Specific KMS usage topic (workflow, best_practices, search_patterns, storage_guidelines)',
            enum: ['workflow', 'best_practices', 'search_patterns', 'storage_guidelines', 'overview']
          }
        }
      }
    }
  }

  async execute(args: { topic?: string }): Promise<any> {
    const topic = args.topic || 'overview'

    const instructions = {
      overview: {
        title: "KMS Autonomous Usage Overview",
        content: `
# Knowledge Management System Autonomous Usage Guide

## Core Principle: Search → Process → Store → Reference

A proper KMS workflow follows this pattern:
1. **Search first** - "What do I already know about this person/situation/challenge?"
2. **Store selectively** - Only meaningful insights, breakthroughs, or patterns worth preserving
3. **Reference actively** - Use stored knowledge to provide better, more personalized responses

## When to Search the KMS
- At the start of conversations to understand context
- Before making recommendations or decisions
- When encountering familiar problems or patterns
- To check for existing solutions or insights

## What to Store
✅ **Store these:**
- Important patterns or preferences
- Key business insights or strategies  
- Technical solutions that actually worked
- Breakthrough moments or "aha!" discoveries
- Persistent user preferences and behaviors
- Cross-domain connections and relationships

❌ **Don't store these:**
- Every troubleshooting step
- Routine conversation details
- Temporary states or one-off events
- Information already well-documented elsewhere

## Multi-Dimensional Storage
The unified KMS automatically routes knowledge to the most appropriate systems:
- **Mem0**: Personal preferences, behavior patterns, episodic memories
- **Neo4j**: Concept relationships, strategy connections, knowledge graphs
- **MongoDB**: Structured data, quantitative metrics, detailed records
        `
      },

      workflow: {
        title: "KMS Autonomous Workflow",
        content: `
# Autonomous KMS Workflow

## 1. Conversation Initiation
\`\`\`
unified_search({
  query: "user preferences communication style",
  filters: { userId: "current_user" }
})
\`\`\`

## 2. Problem-Solving Pattern
\`\`\`
unified_search({
  query: "similar technical issue database connection",
  filters: { contentType: ["solution", "insight"] }
})
\`\`\`

## 3. Decision Making
\`\`\`
unified_search({
  query: "previous decisions architecture patterns",
  filters: { contentType: ["decision", "strategy"] }
})
\`\`\`

## 4. Selective Storage
\`\`\`
unified_store({
  content: "Client responds 40% better to morning sessions vs afternoon",
  contentType: "insight", 
  source: "coaching",
  userId: "client_123"
})
\`\`\`

## 5. Pattern Recognition
\`\`\`
unified_search({
  query: "client engagement patterns timing",
  options: { includeRelationships: true }
})
\`\`\`
        `
      },

      best_practices: {
        title: "KMS Best Practices",
        content: `
# KMS Best Practices for Autonomous Usage

## Search Strategy
- **Be specific**: "React performance optimization" vs "coding help"
- **Use context**: Include user/project/domain information
- **Check relationships**: Enable includeRelationships for deeper insights
- **Filter appropriately**: Use contentType and source filters

## Storage Strategy  
- **Quality over quantity**: Store insights, not transcripts
- **Use clear descriptions**: Future you should understand immediately
- **Include context**: Who, when, why this matters
- **Cross-reference**: Build relationships between related knowledge

## Content Types Guide
- **insight**: Key discoveries, patterns, breakthrough moments
- **fact**: Verified information, metrics, concrete data
- **procedure**: Step-by-step processes that work
- **relationship**: Connections between concepts/people/systems
- **memory**: Personal experiences, preferences, behaviors

## Timing Patterns
- **Search early**: Start conversations with context search
- **Store late**: Wait for actual insights before storing
- **Reference actively**: Use stored knowledge in responses
- **Update iteratively**: Build on existing knowledge

## Multi-User Considerations
- Always include userId when storing personal information
- Use source field to distinguish domains (work, personal, coaching)
- Respect privacy boundaries in cross-user searches
        `
      },

      search_patterns: {
        title: "Effective Search Patterns",
        content: `
# Effective KMS Search Patterns

## Context Discovery Searches
\`\`\`javascript
// User background and preferences
unified_search({
  query: "user communication preferences working style",
  filters: { userId: "current_user", contentType: ["preference", "memory"] }
})

// Project context and history  
unified_search({
  query: "project requirements technical decisions",
  filters: { source: "technical", contentType: ["decision", "insight"] }
})

// Domain expertise patterns
unified_search({
  query: "coaching techniques client engagement",
  filters: { source: "coaching", contentType: ["procedure", "insight"] }
})
\`\`\`

## Problem-Solving Searches
\`\`\`javascript
// Similar problems solved before
unified_search({
  query: "authentication error OAuth token",
  filters: { contentType: ["solution", "procedure"] },
  options: { includeRelationships: true }
})

// Strategy and approach patterns
unified_search({
  query: "client resistance breakthrough techniques", 
  filters: { contentType: ["strategy", "insight"] }
})
\`\`\`

## Relationship Discovery
\`\`\`javascript
// Cross-domain connections
unified_search({
  query: "productivity patterns communication style",
  options: { includeRelationships: true, maxResults: 15 }
})

// Causal relationships
unified_search({
  query: "morning sessions client engagement",
  filters: { contentType: ["relationship", "insight"] }
})
\`\`\`

## Search Quality Tips
- Use natural language descriptions
- Include specific terms when possible
- Cast a wide net initially, then narrow down
- Look for patterns across multiple results
- Follow relationship threads for deeper insights
        `
      },

      storage_guidelines: {
        title: "Strategic Storage Guidelines", 
        content: `
# Strategic KMS Storage Guidelines

## Storage Decision Matrix

### ✅ Always Store
- **Breakthrough insights**: "Finally understood why X approach works"
- **Pattern discoveries**: "Users consistently prefer Y when Z"  
- **Successful solutions**: "Fixed recurring issue with specific approach"
- **Strategic decisions**: "Chose architecture X because of Y constraints"
- **User preferences**: "Client works best with morning sessions"

### 🤔 Consider Storing
- **Refined processes**: Improvements to existing procedures
- **Context-dependent solutions**: Solutions that work in specific situations  
- **Relationship discoveries**: "X technique works better after Y preparation"
- **Threshold insights**: "Performance degrades after 100 concurrent users"

### ❌ Don't Store
- **Routine troubleshooting**: Standard debug steps
- **Temporary states**: "User seems tired today"
- **Obvious information**: "Client wants to improve productivity" 
- **Already documented**: Information available in official docs
- **One-time events**: Unless they reveal patterns

## Content Structuring

### Rich Descriptions
\`\`\`javascript
// Good
unified_store({
  content: "Client achieves 40% better focus during morning sessions (9-11am) compared to afternoon sessions. Hypothesis: natural circadian rhythm alignment with coaching intensity.",
  contentType: "insight"
})

// Poor  
unified_store({
  content: "morning better",
  contentType: "memory"
})
\`\`\`

### Relationship Building
\`\`\`javascript
unified_store({
  content: "Visualization techniques particularly effective for analytical clients who struggle with abstract concepts",
  contentType: "insight",
  relationships: [
    { targetId: "visualization-techniques", type: "EFFECTIVE_FOR", strength: 0.9 },
    { targetId: "analytical-personality", type: "WORKS_WITH", strength: 0.8 }
  ]
})
\`\`\`

## Quality Metrics
- **Actionability**: Can future decisions benefit from this?
- **Uniqueness**: Is this insight available elsewhere?
- **Persistence**: Will this remain relevant over time?
- **Connectivity**: Does this relate to other stored knowledge?
        `
      }
    }

    const result = instructions[topic as keyof typeof instructions]
    
    if (!result) {
      return {
        error: `Unknown topic: ${topic}. Available topics: overview, workflow, best_practices, search_patterns, storage_guidelines`
      }
    }

    return {
      topic: result.title,
      instructions: result.content,
      usage_tip: "Use these guidelines to develop autonomous KMS habits that enhance knowledge discovery and retention patterns."
    }
  }
}