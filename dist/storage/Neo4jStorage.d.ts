/**
 * Neo4j Storage System Implementation
 */
import { StorageSystem, UnifiedKnowledge, KnowledgeQuery, KMSConfig } from '../types/index.js';
export declare class Neo4jStorage implements StorageSystem {
    private config;
    name: string;
    private driver;
    constructor(config: KMSConfig['neo4j']);
    initialize(): Promise<void>;
    store(knowledge: UnifiedKnowledge): Promise<void>;
    search(query: KnowledgeQuery): Promise<any[]>;
    getStats(): Promise<Record<string, any>>;
    findRelated(nodeId: string, maxDepth?: number): Promise<any[]>;
    private createRelationship;
    private createSemanticRelationships;
    private createConstraints;
    close(): Promise<void>;
}
//# sourceMappingURL=Neo4jStorage.d.ts.map