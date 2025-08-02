/**
 * Mem0 Storage System Implementation
 */
import { StorageSystem, UnifiedKnowledge, KnowledgeQuery, KMSConfig } from '../types/index.js';
export declare class Mem0Storage implements StorageSystem {
    private config;
    name: string;
    private client;
    constructor(config: KMSConfig['mem0']);
    initialize(): Promise<void>;
    store(knowledge: UnifiedKnowledge): Promise<void>;
    search(query: KnowledgeQuery): Promise<any[]>;
    getStats(): Promise<Record<string, any>>;
    getMemoriesForUser(userId: string, limit?: number): Promise<any[]>;
    getById(memoryId: string): Promise<any>;
    deleteMemory(memoryId: string): Promise<boolean>;
    private generateUserId;
    private generateUserIdFromQuery;
    private buildMem0Filters;
    private getKnownUserIds;
    testDirectSearch(query: string, userId?: string): Promise<any>;
    close(): Promise<void>;
}
//# sourceMappingURL=Mem0Storage.d.ts.map