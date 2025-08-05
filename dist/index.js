/**
 * Main Unified KMS MCP Server
 * Orchestrates all components into a single, powerful MCP server
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Redis from 'ioredis';
import { HttpTransport } from './transport/HttpTransport';
import { FACTCache } from './cache/FACTCache';
import { IntelligentStorageRouter } from './routing/IntelligentStorageRouter';
import { MongoDBStorage, Neo4jStorage, Mem0Storage } from './storage/index';
import { UnifiedStoreTool, UnifiedSearchTool } from './tools/index';
export class UnifiedKMSServer {
    config;
    server;
    httpTransport;
    redis;
    factCache;
    router;
    storage;
    tools;
    constructor(config) {
        this.config = config;
        this.server = new Server({
            name: 'unified-kms',
            version: '2.0.0',
        }, {
            capabilities: {
                tools: {
                    listChanged: true
                },
                resources: {},
                prompts: {}
            },
        });
        this.setupHandlers();
    }
    /**
     * Initialize all components
     */
    async initialize() {
        console.log('🚀 Initializing Unified KMS Server v2.0...');
        console.log('━'.repeat(60));
        // Step 1: Initialize Redis for FACT cache
        console.log('⚡ Initializing FACT Cache with Redis...');
        this.redis = new Redis(this.config.redis.uri, {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            lazyConnect: true
        });
        // Handle Redis connection errors gracefully
        this.redis.on('error', (error) => {
            console.warn('⚠️  Redis connection error (cache disabled):', error.message);
        });
        this.redis.on('connect', () => {
            console.log('✅ Redis cache connected');
        });
        this.redis.on('close', () => {
            console.warn('⚠️  Redis cache disconnected (fallback to L1 only)');
        });
        this.factCache = new FACTCache(this.config.fact, this.redis);
        // Step 2: Initialize storage systems
        console.log('📊 Initializing Storage Systems...');
        this.storage = {
            mongodb: new MongoDBStorage(this.config.mongodb),
            neo4j: new Neo4jStorage(this.config.neo4j),
            mem0: new Mem0Storage(this.config.mem0)
        };
        // Initialize all storage systems in parallel
        await Promise.all([
            this.storage.mongodb.initialize(),
            this.storage.neo4j.initialize(),
            this.storage.mem0.initialize()
        ]);
        // Step 3: Initialize intelligent router
        console.log('🧠 Initializing Intelligent Router...');
        this.router = new IntelligentStorageRouter();
        // Step 4: Initialize tools
        console.log('🛠️  Initializing Tools...');
        this.tools = {
            store: new UnifiedStoreTool(this.router, this.storage, this.factCache),
            search: new UnifiedSearchTool(this.storage, this.factCache)
        };
        // Step 5: Initialize HTTP transport if needed
        if (this.config.transport.mode === 'http' || this.config.transport.mode === 'dual') {
            if (!this.config.transport.http) {
                throw new Error('HTTP transport configuration is required when mode is http or dual');
            }
            console.log('🌐 Initializing HTTP Transport...');
            this.httpTransport = new HttpTransport({
                port: this.config.transport.http.port,
                host: this.config.transport.http.host,
                cors: this.config.transport.http.cors,
                rateLimit: this.config.transport.http.rateLimit,
                oauth: this.config.oauth
            });
            // Set MCP server factory for HTTP transport
            this.httpTransport.setMcpServerFactory(() => {
                const server = new Server({
                    name: 'unified-kms',
                    version: '2.0.0',
                }, {
                    capabilities: {
                        tools: {
                            listChanged: true
                        },
                        resources: {},
                        prompts: {}
                    },
                });
                // Setup handlers for the new server instance
                this.setupHandlersForServer(server);
                return server;
            });
        }
        console.log('━'.repeat(60));
        console.log('✅ Unified KMS Server initialized successfully!');
        console.log(`🎯 Transport mode: ${this.config.transport.mode}`);
        console.log('🎯 Ready to provide intelligent knowledge management!');
    }
    /**
     * Handle MCP request with authentication context (for HTTP transport)
     */
    async handleMcpRequest(request, authContext) {
        try {
            // Handle different MCP request types
            if (request.method === 'initialize') {
                return await this.handleInitialize(request, authContext);
            }
            else if (request.method === 'notifications/initialized') {
                return await this.handleNotificationInitialized(request, authContext);
            }
            else if (request.method === 'tools/list') {
                return await this.handleListTools(request, authContext);
            }
            else if (request.method === 'tools/call') {
                return await this.handleCallTool(request, authContext);
            }
            else {
                return {
                    jsonrpc: '2.0',
                    error: {
                        code: -32601,
                        message: `Method not found: ${request.method}`
                    },
                    id: request.id
                };
            }
        }
        catch (error) {
            console.error('MCP Request Error:', error);
            return {
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal error',
                    data: error instanceof Error ? error.message : String(error)
                },
                id: request.id
            };
        }
    }
    /**
     * Handle initialize request with auth context
     */
    async handleInitialize(request, authContext) {
        console.log(`🚀 Handling initialize request for client: ${request.params?.clientInfo?.name}`);
        const response = {
            jsonrpc: '2.0',
            result: {
                protocolVersion: '2025-06-18',
                capabilities: {
                    tools: {
                        listChanged: true
                    },
                    resources: {},
                    prompts: {}
                },
                serverInfo: {
                    name: 'unified-kms',
                    version: '2.0.0'
                },
                instructions: "This server provides unified knowledge management with tools for storing and searching across multiple systems."
            },
            id: request.id
        };
        console.log(`📤 Sending initialize response:`, JSON.stringify(response, null, 2));
        return response;
    }
    /**
     * Handle notifications/initialized request (no response needed for notifications)
     */
    async handleNotificationInitialized(request, authContext) {
        console.log(`📢 Client initialization notification received`);
        // Notifications don't require a response in JSON-RPC
        return null;
    }
    /**
     * Handle tools/list request with auth context
     */
    async handleListTools(request, authContext) {
        console.log(`🔧 Handling tools/list request - this means Claude is proceeding after initialize!`);
        // For now, all authenticated users get access to all tools  
        // In production, you might want to filter tools based on user roles/scopes
        const tools = this.getToolDefinitions();
        console.log(`📤 Returning ${tools.length} tools to client`);
        return {
            jsonrpc: '2.0',
            result: { tools },
            id: request.id
        };
    }
    /**
     * Handle tools/call request with auth context
     */
    async handleCallTool(request, authContext) {
        const { name, arguments: args } = request.params;
        // Add auth context to the tool call for audit logging
        console.log(`🔧 Tool call: ${name} by user: ${authContext.user?.id || 'anonymous'}`);
        let result;
        switch (name) {
            case 'unified_store':
                // Add user context to storage if available
                if (authContext.user?.id && !args.userId) {
                    args.userId = authContext.user.id;
                }
                result = await this.tools.store.store(args);
                break;
            case 'unified_search':
                result = await this.tools.search.search(args);
                break;
            case 'get_storage_recommendation':
                result = this.tools.store.getStorageRecommendation(args);
                break;
            case 'get_kms_analytics':
                result = await this.getKMSAnalytics(args);
                break;
            case 'cache_invalidate':
                result = await this.handleCacheInvalidate(args);
                break;
            case 'test_routing':
                result = await this.tools.store.testRouting();
                break;
            case 'get_memory_by_id':
                result = await this.getMemoryById(args);
                break;
            case 'test_mem0_direct_search':
                result = await this.testMem0DirectSearch(args);
                break;
            default:
                throw new Error(`Tool ${name} not found`);
        }
        return {
            jsonrpc: '2.0',
            result: {
                content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
            },
            id: request.id
        };
    }
    /**
     * Get tool definitions
     */
    getToolDefinitions() {
        return [
            {
                name: 'unified_store',
                description: 'Store knowledge with intelligent routing to optimal storage system',
                inputSchema: {
                    type: 'object',
                    properties: {
                        content: {
                            type: 'string',
                            description: 'Knowledge content to store'
                        },
                        contentType: {
                            type: 'string',
                            enum: ['memory', 'insight', 'pattern', 'relationship', 'fact', 'procedure'],
                            description: 'Type of knowledge being stored'
                        },
                        source: {
                            type: 'string',
                            enum: ['coaching', 'personal', 'technical', 'cross_domain'],
                            description: 'Source domain of the knowledge'
                        },
                        userId: {
                            type: 'string',
                            description: 'User ID (optional)'
                        },
                        coachId: {
                            type: 'string',
                            description: 'Coach ID (optional)'
                        },
                        metadata: {
                            type: 'object',
                            description: 'Additional metadata'
                        },
                        confidence: {
                            type: 'number',
                            minimum: 0,
                            maximum: 1,
                            description: 'Confidence score (0-1)'
                        },
                        relationships: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    targetId: { type: 'string' },
                                    type: { type: 'string' },
                                    strength: { type: 'number', minimum: 0, maximum: 1 }
                                },
                                required: ['targetId', 'type', 'strength']
                            },
                            description: 'Relationships to other knowledge nodes'
                        }
                    },
                    required: ['content', 'contentType', 'source']
                }
            },
            {
                name: 'unified_search',
                description: 'Search across all KMS systems with FACT caching and intelligent ranking',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query'
                        },
                        filters: {
                            type: 'object',
                            properties: {
                                contentType: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Filter by content types'
                                },
                                source: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Filter by source domains'
                                },
                                userId: {
                                    type: 'string',
                                    description: 'Filter by user ID'
                                },
                                coachId: {
                                    type: 'string',
                                    description: 'Filter by coach ID'
                                },
                                minConfidence: {
                                    type: 'number',
                                    minimum: 0,
                                    maximum: 1,
                                    description: 'Minimum confidence threshold'
                                }
                            },
                            description: 'Search filters'
                        },
                        options: {
                            type: 'object',
                            properties: {
                                includeRelationships: {
                                    type: 'boolean',
                                    default: true,
                                    description: 'Include related knowledge in results'
                                },
                                maxResults: {
                                    type: 'number',
                                    default: 10,
                                    maximum: 100,
                                    description: 'Maximum number of results'
                                },
                                cacheStrategy: {
                                    type: 'string',
                                    enum: ['aggressive', 'conservative', 'realtime'],
                                    default: 'conservative',
                                    description: 'Caching strategy for results'
                                }
                            },
                            description: 'Search options'
                        }
                    },
                    required: ['query']
                }
            },
            {
                name: 'get_storage_recommendation',
                description: 'Get storage recommendation for given content without storing',
                inputSchema: {
                    type: 'object',
                    properties: {
                        content: {
                            type: 'string',
                            description: 'Content to analyze for storage recommendation'
                        },
                        contentType: {
                            type: 'string',
                            description: 'Optional content type hint'
                        },
                        metadata: {
                            type: 'object',
                            description: 'Optional metadata for context'
                        }
                    },
                    required: ['content']
                }
            },
            {
                name: 'get_kms_analytics',
                description: 'Get comprehensive analytics and performance metrics across all KMS systems',
                inputSchema: {
                    type: 'object',
                    properties: {
                        timeRange: {
                            type: 'string',
                            enum: ['1h', '24h', '7d', '30d'],
                            default: '24h',
                            description: 'Time range for analytics'
                        },
                        includeCache: {
                            type: 'boolean',
                            default: true,
                            description: 'Include cache performance metrics'
                        },
                        includeSystems: {
                            type: 'boolean',
                            default: true,
                            description: 'Include individual system statistics'
                        }
                    }
                }
            },
            {
                name: 'cache_invalidate',
                description: 'Invalidate FACT cache entries matching specific patterns',
                inputSchema: {
                    type: 'object',
                    properties: {
                        pattern: {
                            type: 'string',
                            description: 'Cache key pattern to invalidate (supports wildcards)'
                        },
                        level: {
                            type: 'string',
                            enum: ['L1', 'L2', 'all'],
                            default: 'all',
                            description: 'Cache level to invalidate'
                        }
                    },
                    required: ['pattern']
                }
            },
            {
                name: 'test_routing',
                description: 'Test the intelligent routing system with sample data',
                inputSchema: {
                    type: 'object',
                    properties: {
                        runTests: {
                            type: 'boolean',
                            default: true,
                            description: 'Run predefined routing tests'
                        }
                    }
                }
            },
            {
                name: 'get_memory_by_id',
                description: 'Retrieve specific memory by ID from Mem0 system',
                inputSchema: {
                    type: 'object',
                    properties: {
                        memoryId: {
                            type: 'string',
                            description: 'Memory ID to retrieve'
                        }
                    },
                    required: ['memoryId']
                }
            },
            {
                name: 'test_mem0_direct_search',
                description: 'Test direct Mem0 search to debug connection and search issues',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query to test'
                        },
                        userId: {
                            type: 'string',
                            description: 'User ID to search for (defaults to richard_yaker)',
                            default: 'richard_yaker'
                        }
                    },
                    required: ['query']
                }
            }
        ];
    }
    /**
     * Set up MCP request handlers for a specific server instance
     */
    setupHandlersForServer(server) {
        // List available tools
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: this.getToolDefinitions()
        }));
        // Handle tool calls
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            try {
                let result;
                switch (name) {
                    case 'unified_store':
                        result = await this.tools.store.store(args);
                        break;
                    case 'unified_search':
                        result = await this.tools.search.search(args);
                        break;
                    case 'get_storage_recommendation':
                        result = this.tools.store.getStorageRecommendation(args);
                        break;
                    case 'get_kms_analytics':
                        result = await this.getKMSAnalytics(args);
                        break;
                    case 'cache_invalidate':
                        result = await this.handleCacheInvalidate(args);
                        break;
                    case 'test_routing':
                        result = await this.tools.store.testRouting();
                        break;
                    case 'get_memory_by_id':
                        result = await this.getMemoryById(args);
                        break;
                    case 'test_mem0_direct_search':
                        result = await this.testMem0DirectSearch(args);
                        break;
                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
                }
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify(result, null, 2)
                        }]
                };
            }
            catch (error) {
                console.error(`❌ Tool ${name} failed:`, error);
                throw new McpError(ErrorCode.InternalError, `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }
    /**
     * Set up MCP request handlers (for STDIO transport)
     */
    setupHandlers() {
        this.setupHandlersForServer(this.server);
    }
    /**
     * Get comprehensive KMS analytics
     */
    async getKMSAnalytics(args) {
        console.log('📊 Gathering KMS analytics...');
        const [cacheStats, mongoStats, neo4jStats, mem0Stats] = await Promise.allSettled([
            this.factCache ? this.factCache.getStats() : Promise.resolve({ disabled: true }),
            this.storage.mongodb.getStats(),
            this.storage.neo4j.getStats(),
            this.storage.mem0.getStats()
        ]);
        const analytics = {
            timestamp: new Date().toISOString(),
            cache: cacheStats.status === 'fulfilled' ? cacheStats.value : { error: cacheStats.reason },
            systems: {
                mongodb: mongoStats.status === 'fulfilled' ? mongoStats.value : { error: mongoStats.reason },
                neo4j: neo4jStats.status === 'fulfilled' ? neo4jStats.value : { error: neo4jStats.reason },
                mem0: mem0Stats.status === 'fulfilled' ? mem0Stats.value : { error: mem0Stats.reason }
            },
            routing: this.tools.store.getRoutingStats(),
            overall: {
                systemsHealthy: [mongoStats, neo4jStats, mem0Stats].filter(s => s.status === 'fulfilled').length,
                totalSystems: 3,
                cacheEfficiency: cacheStats.status === 'fulfilled' && cacheStats.value && typeof cacheStats.value === 'object' && 'overall' in cacheStats.value
                    ? cacheStats.value.overall?.cacheEfficiency || 0
                    : 0
            }
        };
        return analytics;
    }
    /**
     * Handle cache invalidation
     */
    async handleCacheInvalidate(args) {
        console.log(`🗑️ Invalidating cache pattern: ${args.pattern}`);
        if (this.factCache) {
            await this.factCache.invalidate(args.pattern);
        }
        return {
            success: true,
            pattern: args.pattern,
            level: args.level,
            timestamp: new Date().toISOString(),
            cacheEnabled: !!this.factCache
        };
    }
    /**
     * Test direct Mem0 search to debug issues
     */
    async testMem0DirectSearch(args) {
        console.log(`🧪 [testMem0DirectSearch] Testing direct Mem0 search: ${args.query}`);
        try {
            const result = await this.storage.mem0.testDirectSearch(args.query, args.userId);
            console.log(`✅ [testMem0DirectSearch] Test completed`);
            return {
                success: true,
                testType: 'direct_mem0_search',
                query: args.query,
                userId: args.userId,
                result,
                timestamp: new Date().toISOString()
            };
        }
        catch (error) {
            console.error(`❌ [testMem0DirectSearch] Test failed:`, error);
            return {
                success: false,
                testType: 'direct_mem0_search',
                query: args.query,
                userId: args.userId,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            };
        }
    }
    /**
     * Get memory by ID from Mem0 system
     */
    async getMemoryById(args) {
        console.log(`🔍 [getMemoryById] Starting retrieval for memory ID: ${args.memoryId}`);
        console.log(`🔍 [getMemoryById] Args received:`, JSON.stringify(args, null, 2));
        try {
            console.log(`🔍 [getMemoryById] Calling storage.mem0.getById...`);
            const memory = await this.storage.mem0.getById(args.memoryId);
            console.log(`✅ [getMemoryById] Successfully retrieved memory`);
            return {
                success: true,
                memoryId: args.memoryId,
                memory,
                source: 'mem0',
                timestamp: new Date().toISOString()
            };
        }
        catch (error) {
            console.error(`❌ [getMemoryById] Failed to retrieve memory ${args.memoryId}:`, error);
            console.error(`❌ [getMemoryById] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
            return {
                success: false,
                memoryId: args.memoryId,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            };
        }
    }
    /**
     * Start the MCP server
     */
    async start() {
        const promises = [];
        // Start STDIO transport if enabled
        if (this.config.transport.mode === 'stdio' || this.config.transport.mode === 'dual') {
            console.log('🖥️  Starting STDIO transport...');
            const transport = new StdioServerTransport();
            promises.push(this.server.connect(transport));
        }
        // Start HTTP transport if enabled
        if (this.config.transport.mode === 'http' || this.config.transport.mode === 'dual') {
            if (this.httpTransport) {
                console.log('🌐 Starting HTTP transport...');
                promises.push(this.httpTransport.start());
            }
        }
        await Promise.all(promises);
        console.log('🌟 Unified KMS MCP Server is running!');
        console.log(`📡 Transport mode: ${this.config.transport.mode}`);
        if (this.httpTransport) {
            const httpConfig = this.config.transport.http;
            console.log(`🌐 HTTP endpoint: http://${httpConfig.host || 'localhost'}:${httpConfig.port}/mcp`);
            console.log(`🔐 OAuth enabled: ${this.config.oauth?.enabled ? 'Yes' : 'No'}`);
        }
    }
    /**
     * Gracefully close all connections
     */
    async close() {
        console.log('🔌 Closing Unified KMS Server...');
        const promises = [
            this.storage.mongodb.close(),
            this.storage.neo4j.close(),
            this.storage.mem0.close(),
            this.redis.quit()
        ];
        // Close HTTP transport if running
        if (this.httpTransport) {
            promises.push(this.httpTransport.stop());
        }
        await Promise.all(promises);
        console.log('✅ All connections closed');
    }
}
/**
 * Main entry point
 */
async function main() {
    // Load configuration from environment
    const config = {
        mongodb: {
            uri: process.env.MONGODB_ATLAS_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017',
            database: process.env.MONGODB_DATABASE || 'unified_kms'
        },
        neo4j: {
            uri: process.env.NEO4J_AURA_URI || process.env.NEO4J_URI || 'bolt://localhost:7687',
            username: process.env.NEO4J_AURA_USERNAME || process.env.NEO4J_USERNAME || 'neo4j',
            password: process.env.NEO4J_AURA_PASSWORD || process.env.NEO4J_PASSWORD || 'password'
        },
        mem0: {
            apiKey: process.env.MEM0_API_KEY,
            orgId: process.env.MEM0_ORG_ID,
            defaultUserId: process.env.MEM0_DEFAULT_USER_ID
        },
        redis: {
            uri: process.env.REDIS_CLOUD_URI || process.env.REDIS_URI || 'redis://localhost:6379'
        },
        fact: {
            l1CacheSize: parseInt(process.env.FACT_L1_SIZE || '104857600'), // 100MB
            l2CacheTTL: parseInt(process.env.FACT_L2_TTL || '1800000'), // 30 minutes
            l3CacheTTL: parseInt(process.env.FACT_L3_TTL || '3600000') // 1 hour
        },
        transport: {
            mode: process.env.TRANSPORT_MODE || 'stdio',
            http: process.env.TRANSPORT_MODE !== 'stdio' ? {
                port: parseInt(process.env.HTTP_PORT || '3001'),
                host: process.env.HTTP_HOST || '0.0.0.0',
                cors: {
                    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
                    credentials: process.env.CORS_CREDENTIALS === 'true'
                },
                rateLimit: {
                    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '900000'), // 15 minutes
                    max: parseInt(process.env.RATE_LIMIT_MAX || '1000')
                }
            } : undefined
        },
        oauth: process.env.OAUTH_ENABLED === 'true' ? {
            enabled: true,
            issuer: process.env.OAUTH_ISSUER,
            audience: process.env.OAUTH_AUDIENCE,
            clientId: process.env.OAUTH_CLIENT_ID,
            clientSecret: process.env.OAUTH_CLIENT_SECRET,
            jwksUri: process.env.OAUTH_JWKS_URI,
            authorizationEndpoint: process.env.OAUTH_AUTHORIZATION_ENDPOINT,
            tokenEndpoint: process.env.OAUTH_TOKEN_ENDPOINT,
            tokenIntrospectionEndpoint: process.env.OAUTH_TOKEN_INTROSPECTION_ENDPOINT,
            userInfoEndpoint: process.env.OAUTH_USER_INFO_ENDPOINT,
            dynamicRegistration: process.env.OAUTH_DYNAMIC_REGISTRATION === 'true' ? {
                enabled: true,
                endpoint: process.env.OAUTH_DYNAMIC_REGISTRATION_ENDPOINT
            } : undefined
        } : undefined
    };
    // Validate required config
    if (!config.mem0.apiKey) {
        console.error('❌ MEM0_API_KEY environment variable is required');
        process.exit(1);
    }
    // Validate OAuth config if enabled
    if (config.oauth?.enabled) {
        if (!config.oauth.issuer || !config.oauth.audience) {
            console.error('❌ OAUTH_ISSUER and OAUTH_AUDIENCE are required when OAuth is enabled');
            process.exit(1);
        }
        if (!config.oauth.jwksUri && !config.oauth.tokenIntrospectionEndpoint) {
            console.error('❌ Either OAUTH_JWKS_URI or OAUTH_TOKEN_INTROSPECTION_ENDPOINT is required for token validation');
            process.exit(1);
        }
    }
    // Validate HTTP transport config
    if ((config.transport.mode === 'http' || config.transport.mode === 'dual') && !config.transport.http) {
        console.error('❌ HTTP transport configuration is required when mode is http or dual');
        process.exit(1);
    }
    const server = new UnifiedKMSServer(config);
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n🛑 Received SIGINT, shutting down gracefully...');
        await server.close();
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
        await server.close();
        process.exit(0);
    });
    try {
        await server.initialize();
        await server.start();
    }
    catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}
// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
//# sourceMappingURL=index.js.map