/**
 * HTTP Transport for Remote MCP Server using official MCP SDK
 * Uses StreamableHTTPServerTransport for proper MCP protocol compliance
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { OAuthConfig } from '../auth/types.js';
export interface HttpTransportConfig {
    port: number;
    host?: string;
    cors?: {
        origin?: string | string[];
        credentials?: boolean;
    };
    rateLimit?: {
        windowMs?: number;
        max?: number;
    };
    oauth?: OAuthConfig;
}
export interface McpServerFactory {
    (): Server;
}
declare global {
    namespace Express {
        interface Request {
            auth?: any;
        }
    }
}
export declare class HttpTransport {
    private config;
    private app;
    private server?;
    private authenticator?;
    private mcpServerFactory?;
    private transports;
    constructor(config: HttpTransportConfig);
    /**
     * Setup Express middleware
     */
    private setupMiddleware;
    /**
     * Setup HTTP routes
     */
    private setupRoutes;
    /**
     * Authenticate request using OAuth2
     */
    private authenticateRequest;
    /**
     * Set MCP server factory
     */
    setMcpServerFactory(factory: McpServerFactory): void;
    /**
     * Handle MCP POST request using StreamableHTTPServerTransport
     */
    private handleMcpPostRequest;
    /**
     * Handle MCP GET request for SSE streams using StreamableHTTPServerTransport
     */
    private handleMcpGetRequest;
    /**
     * Handle MCP DELETE request for session termination using StreamableHTTPServerTransport
     */
    private handleMcpDeleteRequest;
    /**
     * Start HTTP server
     */
    start(): Promise<void>;
    /**
     * Stop HTTP server
     */
    stop(): Promise<void>;
    /**
     * Get transport statistics
     */
    getStats(): Record<string, any>;
    /**
     * Handle OAuth 2.0 Dynamic Client Registration (RFC 7591)
     */
    private handleDynamicClientRegistration;
    /**
     * Handle OAuth authorization with client mapping
     */
    private handleOAuthAuthorize;
    /**
     * Handle OAuth token exchange with client ID mapping
     */
    private handleTokenProxy;
    private createAuth0Client;
    private findMappedClient;
    private storeClientMapping;
    private verifyClientExists;
}
//# sourceMappingURL=HttpTransport.d.ts.map