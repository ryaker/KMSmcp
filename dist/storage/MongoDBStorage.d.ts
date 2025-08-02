/**
 * MongoDB Storage System Implementation
 */
import { StorageSystem, UnifiedKnowledge, KnowledgeQuery, KMSConfig } from '../types/index.js';
export declare class MongoDBStorage implements StorageSystem {
    private config;
    name: string;
    private client;
    private db;
    private collection;
    constructor(config: KMSConfig['mongodb']);
    initialize(): Promise<void>;
    store(knowledge: UnifiedKnowledge): Promise<void>;
    search(query: KnowledgeQuery): Promise<any[]>;
    getStats(): Promise<Record<string, any>>;
    findById(id: string): Promise<UnifiedKnowledge | null>;
    update(id: string, updates: Partial<UnifiedKnowledge>): Promise<boolean>;
    delete(id: string): Promise<boolean>;
    private createIndexes;
    close(): Promise<void>;
}
//# sourceMappingURL=MongoDBStorage.d.ts.map