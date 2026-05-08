/**
 * Mem0 Storage System Implementation
 *
 * Targets mem0ai SDK v3.x (verified against 3.0.2). v1 → v3 contract deltas:
 *  - `add(messages, options)`: top-level `userId` or `user_id` BOTH allowed
 *    (SDK runs camelToSnakeKeys on the merged payload). No rejectTopLevelEntityParams.
 *  - `search(query, options)`: REJECTS top-level entity params via
 *    rejectTopLevelEntityParams() as the very first line. {user_id, agent_id,
 *    app_id, run_id} MUST be passed inside `filters: { ... }`. Throws otherwise.
 *  - `getAll(options)`: same rejection as search. `filters: { user_id }` required.
 *    Returns PaginatedMemories `{ count, next, previous, results }` (was bare array).
 *  - `search`: `limit` → `topK`, `api_version` removed (always /v3/memories/search/).
 *    Return shape `{ results: Memory[] }`.
 *  - `get(memoryId)` only takes a string. The 1.x `get({ user_id, limit })`
 *    overload moved to `getAll(options)`.
 *  - Response keys converted snake → camel by SDK (`createdAt`, `updatedAt`, `userId`).
 *  - `enable_graph` no longer a recognized option (none in this codebase).
 *
 * Verification anchors:
 *  - `node_modules/mem0ai/dist/index.mjs` — rejectTopLevelEntityParams as first line of search/getAll
 *  - `mem0` CLI (npm i -g @mem0/cli) — translates --user-id to filters.user_id
 *  - Live `kms_ping` previously threw on getStats top-level user_id (caught + fixed 2026-05-07)
 */
export class Mem0Storage {
    config;
    name = 'mem0';
    client;
    constructor(config) {
        this.config = config;
    }
    async initialize() {
        console.log('🧠 Connecting to Mem0...');
        // Initialize Mem0 client with telemetry disabled for Node.js environment
        try {
            // Disable Mem0 telemetry in Node.js environment
            process.env.MEM0_TELEMETRY = 'false';
            // Mock window object for Mem0 SDK telemetry
            if (typeof global.window === 'undefined') {
                global.window = {
                    crypto: {
                        subtle: {
                            digest: async () => new ArrayBuffer(32)
                        }
                    },
                    navigator: {
                        userAgent: 'Node.js'
                    }
                };
            }
            const { MemoryClient } = await import('mem0ai');
            this.client = new MemoryClient({
                apiKey: this.config.apiKey
            });
            console.log('✅ Mem0 connected successfully');
        }
        catch (error) {
            console.error('❌ Mem0 connection error:', error);
            throw error;
        }
    }
    async store(knowledge) {
        try {
            console.log(`🧠 Storing in Mem0: ${knowledge.id}`);
            const userId = this.generateUserId(knowledge);
            // Mem0 v3 add expects `user_id` (snake) at top level — NOT `userId` (camel).
            // Same shape as v3 search/getAll (see Mem0Storage.search above and PR #59):
            // the SDK forwards options to the wire as-is for /v1/memories/, and the
            // server requires one of {agent_id, user_id, app_id, run_id} at body root
            // ("non_field_errors: At least one of the filters: ... is required!"
            // observed live in production after the search/getAll fix shipped, since
            // add was overlooked in PR #59). camelCase `userId` is silently dropped.
            const messages = [{
                    role: 'user',
                    content: knowledge.content
                }];
            const options = {
                user_id: userId,
                metadata: {
                    kms_id: knowledge.id,
                    content_type: knowledge.contentType,
                    source: knowledge.source,
                    confidence: knowledge.confidence,
                    timestamp: knowledge.timestamp.toISOString(),
                    ...knowledge.metadata
                }
            };
            await this.client.add(messages, options);
            console.log(`✅ Successfully stored in Mem0 for user: ${userId}`);
        }
        catch (error) {
            console.error('❌ Mem0 storage error:', error);
            throw error;
        }
    }
    async search(query) {
        try {
            console.log(`🔍 Searching Mem0: "${query.query}"`);
            const userId = this.generateUserIdFromQuery(query);
            console.log(`🧠 [Mem0Storage.search] Using user ID: ${userId}`);
            const searchQuery = query.query;
            // Mem0 v3 SDK: search() throws via rejectTopLevelEntityParams() if any of
            // {user_id, agent_id, app_id, run_id} appear at TOP LEVEL of options.
            // Entity-scope MUST go inside `filters`. Verified 2026-05-07 against
            // mem0ai@3.0.2 SDK source (rejectTopLevelEntityParams runs as the FIRST
            // line of search()) and against the live `mem0` CLI (which translates
            // --user-id to filters.user_id internally and works correctly).
            // Previous implementation passed user_id at top level → SDK threw →
            // outer try/catch swallowed → returned [] → Mem0 dimension of dedup
            // gate has been silently dark since the 1.x→3.x cutover.
            const searchOptions = {
                topK: query.options?.maxResults || 10,
                filters: { user_id: userId, ...this.buildMem0Filters(query.filters) }
            };
            console.log(`🧠 [Mem0Storage.search] Search query: "${searchQuery}"`);
            console.log(`🧠 [Mem0Storage.search] Search options:`, JSON.stringify(searchOptions, null, 2));
            const response = await this.client.search(searchQuery, searchOptions);
            const results = Array.isArray(response) ? response : (response?.results ?? []);
            const processedResults = results.map((r) => ({
                id: r.id || r.metadata?.kms_id,
                content: r.memory || '',
                confidence: r.score || r.metadata?.confidence || 0.5,
                metadata: r.metadata || {},
                sourceSystem: 'mem0',
                timestamp: r.metadata?.timestamp ? new Date(r.metadata.timestamp) : new Date(),
                contentType: r.metadata?.content_type,
                source: r.metadata?.source,
                userId: r.userId ?? r.user_id
            }));
            console.log(`🧠 Mem0 found ${processedResults.length} results`);
            return processedResults;
        }
        catch (error) {
            console.warn('⚠️ Mem0 search error:', error);
            return [];
        }
    }
    async getStats() {
        try {
            // v3 SDK: use getAll() with filters.user_id and page_size=1 to get the count.
            // user_id MUST be inside filters — getAll() throws via rejectTopLevelEntityParams
            // if it appears at top level (verified against mem0ai@3.0.2 source).
            const userId = this.config.defaultUserId || 'personal';
            const page = await this.client.getAll({
                page: 1,
                page_size: 1,
                filters: { user_id: userId }
            });
            // Paginated response: { count, next, previous, results }. Bare array fallback for non-paginated.
            const totalMemories = (Array.isArray(page) ? page.length : page?.count) ?? 'unknown';
            return {
                totalMemories,
                userId,
                status: 'connected',
                apiEndpoint: 'Mem0 Cloud (v3)'
            };
        }
        catch (error) {
            console.error('❌ Mem0 stats error:', error);
            return {
                totalMemories: 'unknown',
                status: 'error',
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
    async getMemoriesForUser(userId, limit = 50) {
        try {
            const page = await this.client.getAll({
                page: 1,
                page_size: limit,
                filters: { user_id: userId }
            });
            // getAll runtime shape varies (bare array vs { results: [...], count }).
            const memList = Array.isArray(page) ? page : (page?.results ?? []);
            return memList.map((m) => {
                const created = m.createdAt ?? m.created_at;
                const updated = m.updatedAt ?? m.updated_at;
                return {
                    id: m.id,
                    content: m.memory,
                    metadata: m.metadata,
                    userId: m.userId ?? m.user_id,
                    createdAt: created ? new Date(created) : undefined,
                    updatedAt: updated ? new Date(updated) : undefined
                };
            });
        }
        catch (error) {
            console.error('❌ Mem0 getMemoriesForUser error:', error);
            return [];
        }
    }
    async getById(memoryId) {
        try {
            console.log(`🧠 [Mem0Storage.getById] Starting retrieval for memory ID: ${memoryId}`);
            console.log(`🧠 [Mem0Storage.getById] Memory ID type: ${typeof memoryId}`);
            console.log(`🧠 [Mem0Storage.getById] Memory ID length: ${memoryId?.length}`);
            // v3: client.get(memoryId: string) returns a single Memory object (or throws on 404).
            console.log(`🧠 [Mem0Storage.getById] Calling this.client.get(${memoryId})...`);
            const memory = await this.client.get(memoryId);
            console.log(`🧠 [Mem0Storage.getById] SDK response:`, memory);
            if (memory) {
                console.log(`✅ [Mem0Storage.getById] Found memory ${memoryId}`);
                return memory;
            }
            else {
                console.log(`🧠 [Mem0Storage.getById] Memory ${memoryId} not found (empty response)`);
                throw new Error(`Memory with ID ${memoryId} not found`);
            }
        }
        catch (error) {
            console.error(`❌ [Mem0Storage.getById] Error retrieving memory ${memoryId}:`, error);
            console.error(`❌ [Mem0Storage.getById] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
            throw error;
        }
    }
    async deleteMemory(memoryId) {
        try {
            await this.client.delete(memoryId);
            return true;
        }
        catch (error) {
            console.error('❌ Mem0 delete error:', error);
            return false;
        }
    }
    generateUserId(knowledge) {
        if (knowledge.userId) {
            return knowledge.userId;
        }
        if (knowledge.source === 'personal') {
            return this.config.defaultUserId || 'system_personal';
        }
        return `system_${knowledge.source}`;
    }
    generateUserIdFromQuery(query) {
        if (query.filters?.userId) {
            return query.filters.userId;
        }
        if (!this.config.defaultUserId) {
            console.warn('⚠️ KMS_DEFAULT_USER_ID not configured, using fallback "personal"');
            return 'personal';
        }
        return this.config.defaultUserId;
    }
    buildMem0Filters(filters) {
        if (!filters)
            return {};
        const mem0Filters = {};
        if (filters.contentType) {
            mem0Filters.content_type = filters.contentType;
        }
        if (filters.source) {
            mem0Filters.source = filters.source;
        }
        if (filters.minConfidence) {
            mem0Filters.min_confidence = filters.minConfidence;
        }
        // Subject facet (DG-FACET-A). Mem0 stores arbitrary fields under metadata.*
        // when we pass them via options.metadata at store time (see store()), so
        // filtering on `subject` here surfaces only entries with the matching facet.
        if (filters.subject !== undefined) {
            mem0Filters.subject = filters.subject;
        }
        return mem0Filters;
    }
    getKnownUserIds() {
        const defaultUserId = this.config.defaultUserId || 'personal';
        return [defaultUserId, 'system_technical', 'system_global'];
    }
    async testDirectSearch(query, userId = this.config.defaultUserId || 'personal') {
        try {
            console.log(`🧪 [Mem0Storage.testDirectSearch] Testing direct search for: "${query}" with user: ${userId}`);
            const searchQuery = query;
            // v3 SDK contract: user_id inside filters (see Mem0Storage.search above).
            const searchOptions = {
                topK: 10,
                filters: { user_id: userId }
            };
            console.log(`🧪 [Mem0Storage.testDirectSearch] Search query: "${searchQuery}"`);
            console.log(`🧪 [Mem0Storage.testDirectSearch] Search options:`, JSON.stringify(searchOptions, null, 2));
            const response = await this.client.search(searchQuery, searchOptions);
            const results = Array.isArray(response) ? response : (response?.results ?? []);
            console.log(`🧪 [Mem0Storage.testDirectSearch] Raw results:`, JSON.stringify(results, null, 2));
            return {
                success: true,
                query,
                userId,
                rawResults: results,
                count: results?.length || 0
            };
        }
        catch (error) {
            console.error(`🧪 [Mem0Storage.testDirectSearch] Error:`, error);
            return {
                success: false,
                query,
                userId,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            };
        }
    }
    async close() {
        // Mem0 is a cloud service, no explicit connection to close
        console.log('🧠 Mem0 client cleaned up');
    }
}
