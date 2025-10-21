/**
 * Refactored Tool Definitions following Anthropic's best practices
 * Consolidates 9 tools into 4 focused, high-impact tools
 */

export const REFACTORED_TOOLS = [
  {
    name: 'kms_store',
    description: 'Save information to memory (automatically chooses best storage: personal memories → Mem0, relationships → Neo4j, structured data → MongoDB)',
    inputSchema: {
      type: 'object',
      properties: {
        content: { 
          type: 'string', 
          description: 'The information to save' 
        },
        contentType: { 
          type: 'string', 
          enum: ['memory', 'insight', 'pattern', 'relationship', 'fact', 'procedure', 'auto'],
          default: 'auto',
          description: 'Type of information (auto-detected if not specified)'
        },
        userId: { 
          type: 'string', 
          description: 'Associate with specific user' 
        },
        metadata: { 
          type: 'object', 
          description: 'Additional context or tags' 
        },
        relationships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              targetId: { type: 'string' },
              type: { type: 'string' },
              strength: { type: 'number', minimum: 0, maximum: 1 }
            }
          },
          description: 'Connect to existing knowledge'
        },
        preview: {
          type: 'boolean',
          default: false,
          description: 'Preview storage recommendation without saving'
        },
        responseFormat: {
          type: 'string',
          enum: ['concise', 'detailed'],
          default: 'concise',
          description: 'Control response verbosity'
        }
      },
      required: ['content']
    }
  },

  {
    name: 'kms_search',
    description: 'Find saved information across all memory systems',
    inputSchema: {
      type: 'object',
      properties: {
        query: { 
          type: 'string', 
          description: 'What to search for (or memory ID for direct retrieval)' 
        },
        filters: {
          type: 'object',
          properties: {
            contentType: { 
              type: 'array', 
              items: { type: 'string' },
              description: 'Filter by type (memory, insight, fact, etc.)'
            },
            userId: { 
              type: 'string',
              description: 'Filter by user'
            },
            minConfidence: { 
              type: 'number', 
              minimum: 0, 
              maximum: 1,
              description: 'Minimum relevance score'
            },
            timeRange: {
              type: 'string',
              enum: ['today', 'week', 'month', 'all'],
              default: 'all',
              description: 'When the information was stored'
            }
          },
          description: 'Narrow search results'
        },
        options: {
          type: 'object',
          properties: {
            includeRelated: { 
              type: 'boolean', 
              default: true,
              description: 'Include connected knowledge'
            },
            maxResults: { 
              type: 'number', 
              default: 10, 
              maximum: 50,
              description: 'Limit results'
            },
            searchMode: {
              type: 'string',
              enum: ['hybrid', 'semantic', 'exact', 'id'],
              default: 'hybrid',
              description: 'Search strategy (id mode for direct memory retrieval)'
            },
            responseFormat: {
              type: 'string',
              enum: ['concise', 'detailed'],
              default: 'concise',
              description: 'Control response verbosity'
            }
          }
        }
      },
      required: ['query']
    }
  },

  {
    name: 'kms_manage',
    description: 'Manage memory systems: view analytics, clear cache, debug issues',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['analytics', 'cache_clear', 'health_check', 'debug'],
          description: 'Management action to perform'
        },
        target: {
          type: 'string',
          description: 'Specific system or cache pattern (for cache_clear)'
        },
        options: {
          type: 'object',
          properties: {
            timeRange: { 
              type: 'string', 
              enum: ['1h', '24h', '7d', '30d'], 
              default: '24h',
              description: 'Analytics time window'
            },
            includeDetails: {
              type: 'boolean',
              default: false,
              description: 'Include system-level details'
            },
            debugQuery: {
              type: 'string',
              description: 'Test query for debug mode'
            },
            responseFormat: {
              type: 'string',
              enum: ['concise', 'detailed'],
              default: 'concise',
              description: 'Control response verbosity'
            }
          }
        }
      },
      required: ['action']
    }
  },

  {
    name: 'kms_help',
    description: 'Get guidance on using the knowledge management system effectively',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['quick_start', 'best_practices', 'search_tips', 'storage_guide', 'troubleshooting'],
          default: 'quick_start',
          description: 'Help topic'
        },
        example: {
          type: 'boolean',
          default: true,
          description: 'Include practical examples'
        },
        responseFormat: {
          type: 'string',
          enum: ['concise', 'detailed'],
          default: 'concise',
          description: 'Control response verbosity'
        }
      }
    }
  }
]

/**
 * Tool Response Formatter
 * Ensures responses stay within token limits and format appropriately
 */
export class ResponseFormatter {
  private static readonly MAX_TOKENS = 25000
  private static readonly CONCISE_MAX_TOKENS = 5000

  static format(
    result: any, 
    format: 'concise' | 'detailed' = 'concise'
  ): string {
    const serialized = JSON.stringify(result, null, 2)
    const maxTokens = format === 'concise' 
      ? this.CONCISE_MAX_TOKENS 
      : this.MAX_TOKENS

    if (serialized.length <= maxTokens) {
      return serialized
    }

    // Smart truncation with summary
    return this.truncateWithSummary(result, maxTokens)
  }

  private static truncateWithSummary(data: any, maxTokens: number): string {
    // Extract key information for summary
    const summary = {
      status: data.success !== undefined ? data.success : 'completed',
      itemCount: Array.isArray(data.results) ? data.results.length : undefined,
      systems: data.systems ? Object.keys(data.systems) : undefined,
      timestamp: data.timestamp || new Date().toISOString(),
      message: 'Response truncated due to size. Key data preserved.',
      keyData: this.extractKeyData(data)
    }

    const summaryStr = JSON.stringify(summary, null, 2)
    
    // Try to include as much actual data as possible
    const remainingTokens = maxTokens - summaryStr.length - 100 // Buffer
    const truncatedData = this.intelligentTruncate(data, remainingTokens)

    return JSON.stringify({
      summary,
      data: truncatedData
    }, null, 2)
  }

  private static extractKeyData(data: any): any {
    // Extract most important fields based on data type
    if (Array.isArray(data.results)) {
      return {
        firstItems: data.results.slice(0, 3),
        totalCount: data.results.length
      }
    }
    
    if (data.memory) {
      return {
        memoryId: data.memory.id,
        contentPreview: data.memory.content?.substring(0, 100)
      }
    }

    if (data.analytics) {
      return {
        systemsHealthy: data.analytics.systemsHealthy,
        cacheEfficiency: data.analytics.cacheEfficiency
      }
    }

    return {}
  }

  private static intelligentTruncate(data: any, maxLength: number): any {
    const str = JSON.stringify(data)
    if (str.length <= maxLength) return data

    // For arrays, include fewer items
    if (Array.isArray(data)) {
      const itemCount = Math.floor(data.length * (maxLength / str.length))
      return data.slice(0, Math.max(1, itemCount))
    }

    // For objects, prioritize important fields
    if (typeof data === 'object' && data !== null) {
      const priorityFields = ['id', 'content', 'results', 'success', 'error', 'timestamp']
      const truncated: any = {}
      
      for (const field of priorityFields) {
        if (field in data) {
          truncated[field] = data[field]
        }
      }

      return truncated
    }

    return data
  }
}

/**
 * Error Message Generator
 * Provides actionable, helpful error messages
 */
export class ErrorHelper {
  static toolNotFound(toolName: string): string {
    const availableTools = ['kms_store', 'kms_search', 'kms_manage', 'kms_help']
    
    // Suggest closest match
    const suggestion = this.findClosestMatch(toolName, availableTools)
    
    return `Unknown tool: "${toolName}". Available tools: ${availableTools.join(', ')}. ${
      suggestion ? `Did you mean "${suggestion}"?` : 'Use kms_help for guidance.'
    }`
  }

  static invalidParameter(param: string, expected: string, received: any): string {
    return `Invalid parameter "${param}": expected ${expected}, received ${typeof received}. Example: ${this.getParamExample(param)}`
  }

  static storageError(system: string, error: Error): string {
    const remediation = this.getRemediation(system, error)
    return `${system} storage failed: ${error.message}. ${remediation}`
  }

  private static findClosestMatch(input: string, options: string[]): string | null {
    const normalized = input.toLowerCase().replace(/[_-]/g, '')
    
    for (const option of options) {
      if (option.toLowerCase().includes(normalized) || 
          normalized.includes(option.toLowerCase().replace(/[_-]/g, ''))) {
        return option
      }
    }
    
    return null
  }

  private static getParamExample(param: string): string {
    const examples: Record<string, string> = {
      content: '"Remember that the user prefers morning meetings"',
      query: '"coaching techniques" or "mem_12345" for ID lookup',
      action: '"analytics" or "cache_clear"',
      contentType: '"memory" or "insight"'
    }
    
    return examples[param] || '(see kms_help for examples)'
  }

  private static getRemediation(system: string, error: Error): string {
    if (error.message.includes('ECONNREFUSED')) {
      return `Check if ${system} is running and accessible. For local dev, ensure Docker is running.`
    }
    
    if (error.message.includes('unauthorized') || error.message.includes('401')) {
      return `Check ${system} credentials in environment variables.`
    }
    
    if (error.message.includes('timeout')) {
      return `${system} is slow or unreachable. Try again or check network/service status.`
    }
    
    return 'Check logs for details or use kms_manage action="debug" to diagnose.'
  }
}