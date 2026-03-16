/**
 * Neo4j Storage System Implementation
 */
import neo4j from 'neo4j-driver';
export class Neo4jStorage {
    config;
    name = 'neo4j';
    driver;
    sessionConfig;
    constructor(config) {
        this.config = config;
        this.sessionConfig = config.database ? { database: config.database } : {};
    }
    async initialize() {
        console.log('🔗 Connecting to Neo4j...');
        this.driver = neo4j.driver(this.config.uri, neo4j.auth.basic(this.config.username, this.config.password));
        // Test connection
        const session = this.driver.session(this.sessionConfig);
        try {
            await session.run('RETURN 1');
            console.log('✅ Neo4j connected successfully');
        }
        finally {
            await session.close();
        }
        // Create constraints and indexes
        await this.createConstraints();
    }
    async store(knowledge) {
        const session = this.driver.session(this.sessionConfig);
        try {
            console.log(`🔗 Storing in Neo4j: ${knowledge.id}`);
            // Create the knowledge node
            await session.run(`
        CREATE (k:Knowledge {
          id: $id,
          content: $content,
          contentType: $contentType,
          source: $source,
          userId: $userId,
          confidence: $confidence,
          timestamp: datetime($timestamp),
          metadata: $metadata
        })
      `, {
                id: knowledge.id,
                content: knowledge.content,
                contentType: knowledge.contentType,
                source: knowledge.source,
                userId: knowledge.userId,
                confidence: knowledge.confidence,
                timestamp: knowledge.timestamp.toISOString(),
                metadata: JSON.stringify(knowledge.metadata)
            });
            // Create relationships if specified
            if (knowledge.relationships && knowledge.relationships.length > 0) {
                for (const rel of knowledge.relationships) {
                    await this.createRelationship(session, knowledge.id, rel.targetId, rel.type, rel.strength);
                }
            }
            // Create semantic relationships based on content
            await this.createSemanticRelationships(session, knowledge);
            console.log(`✅ Successfully stored in Neo4j with ${knowledge.relationships?.length || 0} relationships`);
        }
        catch (error) {
            console.error('❌ Neo4j storage error:', error);
            throw error;
        }
        finally {
            await session.close();
        }
    }
    async search(query) {
        const session = this.driver.session(this.sessionConfig);
        try {
            console.log(`🔍 Searching Neo4j: "${query.query}"`);
            // Use fulltext index for broad search across Person, Organization, Project, etc.
            // The old MATCH (k:Knowledge) query returned 0 results because there are 0 Knowledge nodes —
            // all data lives under Person/Organization/Project/Technology/Concept/Service/Event labels.
            const maxResults = Math.floor(query.options?.maxResults || 10);
            let cypher;
            const params = { query: query.query };
            // Build filter conditions based on KnowledgeQuery.filters
            const filterClauses = [];
            if (query.filters?.userId) {
                params.userId = query.filters.userId;
                filterClauses.push('(k.userId IS NULL OR k.userId = $userId)');
            }
            if (query.filters?.source && query.filters.source.length > 0) {
                params.sources = query.filters.source;
                filterClauses.push('(k.source IS NULL OR k.source IN $sources)');
            }
            if (query.filters?.contentType && query.filters.contentType.length > 0) {
                params.contentTypes = query.filters.contentType;
                filterClauses.push('(k.contentType IS NULL OR k.contentType IN $contentTypes)');
            }
            if (query.filters?.minConfidence !== undefined) {
                params.minConfidence = query.filters.minConfidence;
                filterClauses.push('(k.confidence IS NULL OR k.confidence >= $minConfidence)');
            }
            const whereClause = filterClauses.length > 0 ? `WHERE ${filterClauses.join(' AND ')}` : '';
            if (query.options?.includeRelationships) {
                cypher = `
          CALL db.index.fulltext.queryNodes('knowledge_search', $query)
          YIELD node AS k, score
          ${whereClause}
          OPTIONAL MATCH (k)-[r]-(related)
          WHERE related.name IS NOT NULL
          RETURN k, score,
            collect({
              relationship: type(r),
              relatedNode: related.id,
              relatedContent: coalesce(related.name, related.content, ''),
              strength: r.strength
            }) as relationships
          ORDER BY score DESC
          LIMIT ${maxResults}
        `;
            }
            else {
                cypher = `
          CALL db.index.fulltext.queryNodes('knowledge_search', $query)
          YIELD node AS k, score
          ${whereClause}
          RETURN k, score, [] as relationships
          ORDER BY score DESC
          LIMIT ${maxResults}
        `;
            }
            const result = await session.run(cypher, params);
            const results = result.records.map(record => {
                const node = record.get('k').properties;
                const score = record.get('score');
                const relationships = record.get('relationships');
                // Derive a unified content string from whatever text properties exist on the node
                const content = [
                    node.name,
                    node.notes || node.note,
                    node.description,
                    node.content,
                    node.headline,
                    node.profession,
                    node.career,
                    node.purpose,
                    node.industry
                ].filter(Boolean).join(' | ');
                return {
                    id: node.id || node.name,
                    content,
                    confidence: Math.min(score / 5, 1), // normalize fulltext score to 0-1
                    metadata: (() => {
                        if (!node.metadata)
                            return node;
                        try {
                            return JSON.parse(node.metadata);
                        }
                        catch {
                            return node;
                        }
                    })(),
                    sourceSystem: 'neo4j',
                    timestamp: node.timestamp ? new Date(node.timestamp) : new Date(),
                    contentType: node.type || node.contentType || 'graph_node',
                    source: 'neo4j',
                    nodeLabels: record.get('k').labels,
                    relationships: relationships.filter((r) => r.relatedNode)
                };
            });
            console.log(`🔗 Neo4j found ${results.length} results`);
            return results;
        }
        catch (error) {
            console.warn('⚠️ Neo4j search error:', error);
            return [];
        }
        finally {
            await session.close();
        }
    }
    async getStats() {
        const session = this.driver.session(this.sessionConfig);
        try {
            // Get node counts
            const nodeResult = await session.run(`
        MATCH (n)
        RETURN count(n) as totalNodes
      `);
            const totalNodes = nodeResult.records[0]?.get('totalNodes').toNumber() || 0;
            // Get relationship counts
            const relResult = await session.run(`
        MATCH ()-[r]->()
        RETURN count(r) as totalRelationships
      `);
            const totalRelationships = relResult.records[0]?.get('totalRelationships').toNumber() || 0;
            // Get content type distribution
            const contentTypeResult = await session.run(`
        MATCH (n:Knowledge)
        RETURN n.contentType as contentType, count(n) as count
        ORDER BY count DESC
      `);
            const contentTypes = Object.fromEntries(contentTypeResult.records.map(r => [r.get('contentType'), r.get('count').toNumber()]));
            // Get relationship type distribution
            const relTypeResult = await session.run(`
        MATCH ()-[r]->()
        RETURN type(r) as relType, count(r) as count
        ORDER BY count DESC
      `);
            const relationshipTypes = Object.fromEntries(relTypeResult.records.map(r => [r.get('relType'), r.get('count').toNumber()]));
            // Get highly connected nodes (insights with many relationships)
            const hubResult = await session.run(`
        MATCH (n:Knowledge)-[r]-()
        RETURN n.id as nodeId, n.content as content, count(r) as connections
        ORDER BY connections DESC
        LIMIT 5
      `);
            const knowledgeHubs = hubResult.records.map(r => ({
                id: r.get('nodeId'),
                content: r.get('content').slice(0, 50) + '...',
                connections: r.get('connections').toNumber()
            }));
            return {
                totalNodes,
                totalRelationships,
                contentTypes,
                relationshipTypes,
                knowledgeHubs,
                status: 'connected',
                graphDensity: totalNodes > 0 ? totalRelationships / totalNodes : 0
            };
        }
        catch (error) {
            console.error('❌ Neo4j stats error:', error);
            return {
                totalNodes: 0,
                totalRelationships: 0,
                status: 'error',
                error: error instanceof Error ? error.message : String(error)
            };
        }
        finally {
            await session.close();
        }
    }
    async findRelated(nodeId, maxDepth = 2) {
        const session = this.driver.session(this.sessionConfig);
        try {
            const result = await session.run(`
        MATCH (start:Knowledge {id: $nodeId})
        MATCH path = (start)-[*1..${maxDepth}]-(related:Knowledge)
        WHERE related.id <> $nodeId
        RETURN related, length(path) as distance, 
               relationships(path) as pathRelationships
        ORDER BY distance, related.confidence DESC
        LIMIT 20
      `, { nodeId });
            return result.records.map(record => {
                const node = record.get('related').properties;
                const distance = record.get('distance').toNumber();
                const pathRels = record.get('pathRelationships');
                return {
                    id: node.id,
                    content: node.content,
                    confidence: node.confidence,
                    distance,
                    pathTypes: pathRels.map((r) => r.type),
                    sourceSystem: 'neo4j'
                };
            });
        }
        finally {
            await session.close();
        }
    }
    async createRelationship(session, sourceId, targetId, relationshipType, strength) {
        try {
            // Sanitize relationship type (Neo4j requires valid identifiers)
            const safeRelType = relationshipType.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            await session.run(`
        MATCH (source:Knowledge {id: $sourceId})
        MATCH (target:Knowledge {id: $targetId})
        CREATE (source)-[r:${safeRelType} {strength: $strength, created: datetime()}]->(target)
      `, {
                sourceId,
                targetId,
                strength
            });
        }
        catch (error) {
            console.warn(`⚠️ Failed to create relationship ${relationshipType}:`, error);
        }
    }
    async createSemanticRelationships(session, knowledge) {
        // Create relationships based on content similarity and coaching context
        try {
            if (knowledge.contentType === 'insight' || knowledge.contentType === 'relationship') {
                // Find related insights/techniques
                const result = await session.run(`
          MATCH (existing:Knowledge)
          WHERE existing.id <> $id 
            AND existing.contentType IN ['insight', 'relationship']
            AND (
              existing.content CONTAINS $searchTerm1 OR
              existing.content CONTAINS $searchTerm2
            )
          RETURN existing.id as relatedId
          LIMIT 5
        `, {
                    id: knowledge.id,
                    searchTerm1: knowledge.contentType,
                    searchTerm2: knowledge.source
                });
                // Create semantic relationships
                for (const record of result.records) {
                    const relatedId = record.get('relatedId');
                    await this.createRelationship(session, knowledge.id, relatedId, 'RELATED_TO', 0.6);
                }
            }
        }
        catch (error) {
            console.warn('⚠️ Failed to create semantic relationships:', error);
        }
    }
    async createConstraints() {
        const session = this.driver.session(this.sessionConfig);
        try {
            // Create unique constraint on Knowledge.id
            await session.run(`
        CREATE CONSTRAINT knowledge_id_unique IF NOT EXISTS
        FOR (k:Knowledge) REQUIRE k.id IS UNIQUE
      `);
            // Create indexes for better query performance
            await session.run(`
        CREATE INDEX knowledge_content_index IF NOT EXISTS
        FOR (k:Knowledge) ON (k.content)
      `);
            await session.run(`
        CREATE INDEX knowledge_type_index IF NOT EXISTS
        FOR (k:Knowledge) ON (k.contentType)
      `);
            await session.run(`
        CREATE INDEX knowledge_confidence_index IF NOT EXISTS
        FOR (k:Knowledge) ON (k.confidence)
      `);
            console.log('🔗 Neo4j constraints and indexes created');
        }
        catch (error) {
            console.warn('⚠️ Neo4j constraint creation warning:', error);
        }
        finally {
            await session.close();
        }
    }
    /**
     * Return a brief entity card for a node by ID.
     * Used by UnifiedSearchTool for context expansion — keeps output small and agent-friendly.
     */
    async getEntitySummary(id) {
        const session = this.driver.session(this.sessionConfig);
        try {
            const result = await session.run(`
        MATCH (n {id: $id})
        OPTIONAL MATCH (n)-[r]-(related)
        WHERE related.name IS NOT NULL
        WITH n, labels(n) AS nodeLabels,
             collect({
               rel: type(r),
               name: related.name,
               id: related.id,
               type: labels(related)[0]
             })[0..4] AS topRelationships
        RETURN n, nodeLabels, topRelationships
        LIMIT 1
      `, { id });
            if (result.records.length === 0)
                return null;
            const rec = result.records[0];
            const node = rec.get('n').properties;
            const nodeLabels = rec.get('nodeLabels');
            const topRelationships = rec.get('topRelationships');
            // Build a compact summary — only fields an agent needs at a glance
            const summary = {
                id: node.id || id,
                name: node.name,
                type: nodeLabels,
                summary: [node.headline, node.profession, node.description, node.notes, node.purpose]
                    .filter(Boolean)
                    .join(' | ')
                    .slice(0, 200) || null,
                key_props: {},
                top_relationships: topRelationships.filter((r) => r.name)
            };
            // Include a small selection of domain-relevant properties
            const domainProps = ['expertise', 'industry', 'career', 'role', 'status', 'domain',
                'taskPattern', 'approach', 'path', 'notes'];
            for (const prop of domainProps) {
                if (node[prop])
                    summary.key_props[prop] = node[prop];
            }
            return summary;
        }
        catch (error) {
            console.warn('⚠️ Neo4j getEntitySummary error:', error);
            return null;
        }
        finally {
            await session.close();
        }
    }
    /**
     * Return all ContextTrigger and ToolRoute nodes so UnifiedSearchTool
     * can match them client-side against the current query.
     */
    async getOperationalNodes() {
        const session = this.driver.session(this.sessionConfig);
        try {
            const result = await session.run(`
        MATCH (n)
        WHERE n.type IN ['ContextTrigger', 'ToolRoute']
        RETURN n.id AS id, n.type AS type, n.name AS name,
               coalesce(n.description, n.taskPattern, '') AS description,
               coalesce(n.actions, []) AS actions,
               n.taskPattern AS taskPattern
      `);
            return result.records.map(r => ({
                id: r.get('id'),
                type: r.get('type'),
                name: r.get('name'),
                description: r.get('description') || '',
                actions: r.get('actions') || [],
                taskPattern: r.get('taskPattern')
            }));
        }
        catch (error) {
            console.warn('⚠️ Neo4j getOperationalNodes error:', error);
            return [];
        }
        finally {
            await session.close();
        }
    }
    /**
     * Return all Person/Organization/Project/Technology/Concept/Service nodes
     * that have both an id and a name. Used by EntityLinker for entity extraction.
     * Results are cached by the caller — this fetches fresh from Neo4j each call.
     */
    async getEntityCandidates() {
        const session = this.driver.session(this.sessionConfig);
        try {
            const result = await session.run(`
        MATCH (n)
        WHERE ANY(label IN labels(n) WHERE label IN ['Person','Organization','Project','Technology','Concept','Service'])
          AND n.id IS NOT NULL
          AND n.name IS NOT NULL
        RETURN n.id AS id, n.name AS name,
               labels(n) AS labels,
               coalesce(n.aliases, []) AS aliases
        LIMIT 500
      `);
            return result.records.map(r => ({
                id: r.get('id'),
                name: r.get('name'),
                labels: r.get('labels'),
                aliases: r.get('aliases') || []
            }));
        }
        catch (error) {
            console.warn('⚠️ Neo4j getEntityCandidates error:', error);
            return [];
        }
        finally {
            await session.close();
        }
    }
    /**
     * Create ABOUT relationships from a stored Knowledge node to entity nodes.
     * Used by EntityLinker after extracting entity mentions from stored content.
     * Best-effort — silently skips entity IDs that don't exist in the graph.
     */
    async createAboutRelationships(sourceId, targetEntityIds) {
        if (targetEntityIds.length === 0)
            return;
        const session = this.driver.session(this.sessionConfig);
        try {
            await session.run(`
        UNWIND $targetIds AS targetId
        MATCH (e {id: targetId})
        MERGE (k:Knowledge {id: $sourceId})
        MERGE (k)-[r:ABOUT]->(e)
        SET r.createdAt = datetime(), r.source = 'enrichment'
      `, {
                sourceId,
                targetIds: targetEntityIds
            });
            console.log(`🔗 Neo4j: created ABOUT relationships: ${sourceId} → [${targetEntityIds.join(', ')}]`);
        }
        catch (error) {
            console.warn('⚠️ Neo4j createAboutRelationships error:', error);
            // Swallow — enrichment is best-effort
        }
        finally {
            await session.close();
        }
    }
    async close() {
        if (this.driver) {
            await this.driver.close();
            console.log('🔗 Neo4j connection closed');
        }
    }
}
