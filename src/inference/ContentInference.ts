/**
 * Smart Content Inference Engine
 * Automatically detects patterns and suggests metadata without elicitation
 */

export interface InferenceResult {
  contentType: 'memory' | 'insight' | 'pattern' | 'relationship' | 'fact' | 'procedure'
  confidence: number
  suggestedTags: string[]
  detectedProject?: string
  temporalContext?: 'recent' | 'historical' | 'future'
  relatedPatterns: string[]
  language?: string
  framework?: string[]
}

export class ContentInference {
  // Pattern matchers for content type detection
  private static readonly CONTENT_PATTERNS = {
    memory: [
      /\b(remember|recalled?|last time|previously)\b/i,
      /\b(prefer|like|enjoy|hate|dislike)\b/i,
      /\b(my|I|me|mine)\b.*\b(think|feel|believe|want)\b/i
    ],
    insight: [
      /\b(realized?|discovered?|learned?|understood)\b/i,
      /\b(aha|breakthrough|eureka|finally)\b/i,
      /\b(turns out|it seems|apparently)\b/i
    ],
    pattern: [
      /\b(always|usually|often|frequently|consistently)\b/i,
      /\b(pattern|trend|correlation|whenever)\b/i,
      /\b(every time|each time|repeatedly)\b/i
    ],
    procedure: [
      /\b(fixed|solved|resolved|implemented)\b/i,
      /\b(bug|issue|error|problem)\b.*\b(fix|solution)\b/i,
      /\b(step \d+|first|then|finally|to do)\b/i,
      /\b(install|configure|setup|deploy)\b/i
    ],
    fact: [
      /\b(config|setting|parameter|value)\b/i,
      /\b(version|release|update)\b.*\b\d+\.\d+/i,
      /\b(enabled?|disabled?|true|false)\b/i,
      /\b(url|endpoint|api|port)\b.*[:=]/i
    ],
    relationship: [
      /\b(relates? to|connects? to|links? to)\b/i,
      /\b(causes?|effects?|results? in)\b/i,
      /\b(depends? on|requires?|needs?)\b/i
    ]
  }

  // Project detection patterns
  private static readonly PROJECT_PATTERNS = [
    { pattern: /KMSmcp|KMS MCP|knowledge management/i, project: 'KMSmcp' },
    { pattern: /coaching.?clone/i, project: 'CoachingClone' },
    { pattern: /gondola|PEMLeads/i, project: 'Gondola' },
    { pattern: /OAuth|JWKS|authentication/i, project: 'auth-system' }
  ]

  // Programming language detection
  private static readonly LANGUAGE_PATTERNS = [
    { pattern: /\b(typescript|\.ts|tsx|interface|type\s+\w+\s*=)\b/i, language: 'typescript' },
    { pattern: /\b(javascript|\.js|jsx|const|let|var)\b/i, language: 'javascript' },
    { pattern: /\b(python|\.py|def\s+\w+|import\s+\w+|pip)\b/i, language: 'python' },
    { pattern: /\b(rust|\.rs|cargo|fn\s+\w+|impl)\b/i, language: 'rust' },
    { pattern: /\b(go|golang|\.go|func\s+\w+|package\s+\w+)\b/i, language: 'go' }
  ]

  // Framework detection
  private static readonly FRAMEWORK_PATTERNS = [
    { pattern: /\b(react|useState|useEffect|jsx)\b/i, framework: 'react' },
    { pattern: /\b(next\.?js|getServerSideProps|getStaticProps)\b/i, framework: 'nextjs' },
    { pattern: /\b(express|app\.(get|post|put|delete))\b/i, framework: 'express' },
    { pattern: /\b(mongodb|mongoose|collection|findOne)\b/i, framework: 'mongodb' },
    { pattern: /\b(neo4j|cypher|MATCH|CREATE)\b/i, framework: 'neo4j' },
    { pattern: /\b(mem0|memory|episodic|semantic)\b/i, framework: 'mem0' },
    { pattern: /\b(redis|cache|TTL)\b/i, framework: 'redis' },
    { pattern: /\b(MCP|model context protocol)\b/i, framework: 'mcp' }
  ]

  /**
   * Analyze content and infer metadata
   */
  static analyze(content: string): InferenceResult {
    const result: InferenceResult = {
      contentType: 'fact', // default
      confidence: 0.5,
      suggestedTags: [],
      relatedPatterns: []
    }

    // Detect content type
    let bestMatch = { type: 'fact' as InferenceResult['contentType'], score: 0 }

    for (const [type, patterns] of Object.entries(this.CONTENT_PATTERNS)) {
      const matches = patterns.filter(p => p.test(content)).length
      const score = matches / patterns.length

      if (score > bestMatch.score) {
        bestMatch = { type: type as InferenceResult['contentType'], score }
      }
    }

    result.contentType = bestMatch.type
    result.confidence = Math.min(0.9, 0.5 + bestMatch.score * 0.4)

    // Detect project
    for (const { pattern, project } of this.PROJECT_PATTERNS) {
      if (pattern.test(content)) {
        result.detectedProject = project
        result.suggestedTags.push(project.toLowerCase())
        break
      }
    }

    // Detect temporal context
    if (/\b(today|now|currently|just|right now)\b/i.test(content)) {
      result.temporalContext = 'recent'
    } else if (/\b(yesterday|last week|last month|previously|before)\b/i.test(content)) {
      result.temporalContext = 'historical'
    } else if (/\b(tomorrow|next|will|going to|plan to)\b/i.test(content)) {
      result.temporalContext = 'future'
    }

    // Detect programming language
    for (const { pattern, language } of this.LANGUAGE_PATTERNS) {
      if (pattern.test(content)) {
        result.language = language
        result.suggestedTags.push(language)
        break
      }
    }

    // Detect frameworks
    const detectedFrameworks: string[] = []
    for (const { pattern, framework } of this.FRAMEWORK_PATTERNS) {
      if (pattern.test(content)) {
        detectedFrameworks.push(framework)
        result.suggestedTags.push(framework)
      }
    }
    if (detectedFrameworks.length > 0) {
      result.framework = detectedFrameworks
    }

    // Extract potential patterns
    const patternMatches = content.match(/\b(always|usually|often|frequently|never|rarely)\s+[\w\s]{3,30}/gi)
    if (patternMatches) {
      result.relatedPatterns = patternMatches.slice(0, 3)
    }

    // Add content-type specific tags
    result.suggestedTags.push(result.contentType)
    if (result.temporalContext) {
      result.suggestedTags.push(result.temporalContext)
    }

    // Remove duplicates
    result.suggestedTags = [...new Set(result.suggestedTags)]

    return result
  }

  /**
   * Generate smart metadata based on inference
   */
  static generateMetadata(content: string, existingMetadata?: Record<string, any>): Record<string, any> {
    const inference = this.analyze(content)

    return {
      ...existingMetadata,
      inferred: {
        contentType: inference.contentType,
        confidence: inference.confidence,
        project: inference.detectedProject,
        temporal: inference.temporalContext,
        language: inference.language,
        frameworks: inference.framework,
        timestamp: new Date().toISOString()
      },
      tags: [
        ...(existingMetadata?.tags || []),
        ...inference.suggestedTags
      ].filter(Boolean),
      searchHints: inference.relatedPatterns
    }
  }

  /**
   * Suggest relationships based on content
   */
  static suggestRelationships(content: string): Array<{ type: string; description: string }> {
    const suggestions: Array<{ type: string; description: string }> = []

    if (/\b(fix|solution|resolved?)\b/i.test(content)) {
      suggestions.push({
        type: 'SOLVES',
        description: 'Links to the problem this solves'
      })
    }

    if (/\b(causes?|leads? to|results? in)\b/i.test(content)) {
      suggestions.push({
        type: 'CAUSES',
        description: 'Links to effects or outcomes'
      })
    }

    if (/\b(requires?|depends? on|needs?)\b/i.test(content)) {
      suggestions.push({
        type: 'REQUIRES',
        description: 'Links to dependencies'
      })
    }

    if (/\b(similar|like|same as)\b/i.test(content)) {
      suggestions.push({
        type: 'SIMILAR_TO',
        description: 'Links to similar concepts'
      })
    }

    if (/\b(part of|belongs? to|included? in)\b/i.test(content)) {
      suggestions.push({
        type: 'PART_OF',
        description: 'Links to parent concept'
      })
    }

    return suggestions
  }

  /**
   * Get confidence-boosting questions (for future elicitation)
   */
  static getElicitationQuestions(content: string, inference: InferenceResult): string[] {
    const questions: string[] = []

    if (!inference.detectedProject && inference.contentType === 'procedure') {
      questions.push('Which project is this solution for?')
    }

    if (inference.confidence < 0.7) {
      questions.push(`Is this best categorized as ${inference.contentType}?`)
    }

    if (inference.framework && inference.framework.length > 2) {
      questions.push('Which is the primary framework involved?')
    }

    if (!inference.temporalContext && inference.contentType === 'insight') {
      questions.push('When did you discover this insight?')
    }

    return questions
  }
}