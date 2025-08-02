/**
 * Main Unified KMS MCP Server
 * Orchestrates all components into a single, powerful MCP server
 */
import { KMSConfig } from './types/index.js';
export declare class UnifiedKMSServer {
    private config;
    private server;
    private httpTransport?;
    private redis;
    private factCache;
    private router;
    private storage;
    private tools;
    constructor(config: KMSConfig);
    /**
     * Initialize all components
     */
    initialize(): Promise<void>;
    /**
     * Handle MCP request with authentication context (for HTTP transport)
     */
    private handleMcpRequest;
    /**
     * Handle initialize request with auth context
     */
    private handleInitialize;
    /**
     * Handle notifications/initialized request (no response needed for notifications)
     */
    private handleNotificationInitialized;
    /**
     * Handle tools/list request with auth context
     */
    private handleListTools;
    /**
     * Handle tools/call request with auth context
     */
    private handleCallTool;
    /**
     * Get tool definitions
     */
    private getToolDefinitions;
    /**
     * Set up MCP request handlers for a specific server instance
     */
    private setupHandlersForServer;
    /**
     * Set up MCP request handlers (for STDIO transport)
     */
    private setupHandlers;
    /**
     * Get comprehensive KMS analytics
     */
    private getKMSAnalytics;
    /**
     * Handle cache invalidation
     */
    private handleCacheInvalidate;
    /**
     * Test direct Mem0 search to debug issues
     */
    private testMem0DirectSearch;
    /**
     * Get memory by ID from Mem0 system
     */
    private getMemoryById;
    /**
     * Start the MCP server
     */
    start(): Promise<void>;
    /**
     * Gracefully close all connections
     */
    close(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map