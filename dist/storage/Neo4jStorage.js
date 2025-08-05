/**
 * Neo4j Storage System Implementation
 */
import neo4j from 'neo4j-driver';
export class Neo4jStorage {
    config;
    name = 'neo4j';
    driver;
    constructor(config) {
        this.config = config;
    }
    async initialize() {
        console.log('🔗 Connecting to Neo4j...');
        this.driver = neo4j.driver(this.config.uri, neo4j.auth.basic(this.config.username, this.config.password));
        // Test connection
        const session = this.driver.session();
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
        const session = this.driver.session();
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
          coachId: $coachId,
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
                coachId: knowledge.coachId,
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
        const session = this.driver.session();
        try {
            console.log(`🔍 Searching Neo4j: "${query.query}"`);
            let cypher = `
        MATCH (k:Knowledge)
        WHERE k.content CONTAINS $query
      `;
            const params = { query: query.query };
            // Add filters
            if (query.filters?.contentType) {
                cypher += ` AND k.contentType IN $contentTypes`;
                params.contentTypes = query.filters.contentType;
            }
            if (query.filters?.source) {
                cypher += ` AND k.source IN $sources`;
                params.sources = query.filters.source;
            }
            if (query.filters?.userId) {
                cypher += ` AND k.userId = $userId`;
                params.userId = query.filters.userId;
            }
            if (query.filters?.coachId) {
                cypher += ` AND k.coachId = $coachId`;
                params.coachId = query.filters.coachId;
            }
            if (query.filters?.minConfidence) {
                cypher += ` AND k.confidence >= $minConfidence`;
                params.minConfidence = query.filters.minConfidence;
            }
            // Include relationships if requested
            if (query.options?.includeRelationships) {
                cypher += `
          OPTIONAL MATCH (k)-[r]-(related:Knowledge)
          RETURN k, collect({
            relationship: type(r),
            relatedNode: related.id,
            relatedContent: related.content,
            strength: r.strength
          }) as relationships
        `;
            }
            else {
                cypher += ` RETURN k, [] as relationships`;
            }
            cypher += `
        ORDER BY k.confidence DESC, k.timestamp DESC
        LIMIT ${query.options?.maxResults || 10}
      `;
            const result = await session.run(cypher, params);
            const results = result.records.map(record => {
                const node = record.get('k').properties;
                const relationships = record.get('relationships');
                return {
                    id: node.id,
                    content: node.content,
                    confidence: node.confidence,
                    metadata: JSON.parse(node.metadata || '{}'),
                    sourceSystem: 'neo4j',
                    timestamp: new Date(node.timestamp),
                    contentType: node.contentType,
                    source: node.source,
                    relationships: relationships.filter((r) => r.relatedNode) // Filter out empty relationships
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
        const session = this.driver.session();
        try {
            // Get node counts
            const nodeResult = await session.run(`
        MATCH (n:Knowledge)
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
        const session = this.driver.session();
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
              existing.content CONTAINS $searchTerm2 OR
              existing.coachId = $coachId
            )
          RETURN existing.id as relatedId
          LIMIT 5
        `, {
                    id: knowledge.id,
                    searchTerm1: knowledge.contentType,
                    searchTerm2: knowledge.source,
                    coachId: knowledge.coachId
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
        const session = this.driver.session();
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
    async close() {
        if (this.driver) {
            await this.driver.close();
            console.log('🔗 Neo4j connection closed');
        }
    }
}
