/**
 * HTTP Transport for Remote MCP Server using official MCP SDK
 * Uses StreamableHTTPServerTransport for proper MCP protocol compliance
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { OAuth2Authenticator } from '../auth/OAuth2Authenticator.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
export class HttpTransport {
    config;
    app;
    server;
    authenticator;
    mcpServerFactory;
    transports = new Map();
    constructor(config) {
        this.config = config;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
        if (config.oauth?.enabled) {
            this.authenticator = new OAuth2Authenticator(config.oauth);
        }
    }
    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        // Trust proxy for ngrok/reverse proxy support
        this.app.set('trust proxy', 1);
        // Security headers
        this.app.use(helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false,
        }));
        // CORS
        this.app.use(cors({
            origin: this.config.cors?.origin || true,
            credentials: this.config.cors?.credentials || true,
            methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'mcp-session-id', 'last-event-id']
        }));
        // Rate limiting
        this.app.use(rateLimit({
            windowMs: this.config.rateLimit?.windowMs || 15 * 60 * 1000,
            max: this.config.rateLimit?.max || 1000,
            message: 'Too many requests from this IP, please try again later.',
            standardHeaders: true,
            legacyHeaders: false
        }));
        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        // Request logging
        this.app.use((req, res, next) => {
            const timestamp = new Date().toISOString();
            console.log(`${timestamp} ${req.method} ${req.path}`);
            if (req.method === 'POST' && req.path.includes('/mcp')) {
                console.log(`  ↳ MCP Request Body:`, JSON.stringify(req.body, null, 2));
            }
            next();
        });
    }
    /**
     * Setup HTTP routes
     */
    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: '2.0.0'
            });
        });
        // OAuth metadata endpoints (if OAuth is enabled)
        if (this.config.oauth?.enabled) {
            // OAuth 2.0 Authorization Server Metadata (RFC 8414)
            this.app.get('/.well-known/oauth-authorization-server', (req, res) => {
                res.json({
                    issuer: this.config.oauth.issuer,
                    authorization_endpoint: `${req.protocol}://${req.get('host')}/authorize`,
                    token_endpoint: `${req.protocol}://${req.get('host')}/oauth/token`,
                    jwks_uri: this.config.oauth.jwksUri,
                    registration_endpoint: `${req.protocol}://${req.get('host')}/register`,
                    scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
                    response_types_supported: ['code'],
                    grant_types_supported: ['authorization_code']
                });
            });
            // OAuth 2.0 Authorization Server Metadata for MCP (v2 to force cache refresh)
            this.app.get('/.well-known/oauth-authorization-server/mcp-v2', (req, res) => {
                res.json({
                    issuer: this.config.oauth.issuer,
                    authorization_endpoint: `${req.protocol}://${req.get('host')}/authorize`,
                    token_endpoint: `${req.protocol}://${req.get('host')}/oauth/token`,
                    jwks_uri: this.config.oauth.jwksUri,
                    registration_endpoint: `${req.protocol}://${req.get('host')}/register`,
                    scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
                    response_types_supported: ['code'],
                    grant_types_supported: ['authorization_code']
                });
            });
            // OAuth 2.0 Protected Resource Metadata (RFC 9728)
            this.app.get('/.well-known/oauth-protected-resource', (req, res) => {
                const metadata = {
                    resource: this.config.oauth.audience,
                    authorization_servers: [this.config.oauth.issuer],
                    scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
                    bearer_methods_supported: ['header'],
                    resource_documentation: 'https://modelcontextprotocol.io'
                };
                res.json(metadata);
            });
            // OAuth 2.0 Protected Resource Metadata for MCP  
            this.app.get('/.well-known/oauth-protected-resource/mcp-v2', (req, res) => {
                const metadata = {
                    resource: this.config.oauth.audience,
                    authorization_servers: [this.config.oauth.issuer],
                    scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
                    bearer_methods_supported: ['header'],
                    resource_documentation: 'https://modelcontextprotocol.io'
                };
                res.json(metadata);
            });
            // Dynamic client registration endpoint
            this.app.post('/register', this.handleDynamicClientRegistration.bind(this));
            // OAuth authorization endpoint with client mapping
            this.app.get('/authorize', this.handleOAuthAuthorize.bind(this));
            // OAuth token proxy endpoint
            this.app.post('/oauth/token', this.handleTokenProxy.bind(this));
        }
        // MCP endpoints using proper SDK StreamableHTTPServerTransport
        if (this.config.oauth?.enabled) {
            this.app.post('/mcp', this.authenticateRequest.bind(this), this.handleMcpPostRequest.bind(this));
            this.app.get('/mcp', this.authenticateRequest.bind(this), this.handleMcpGetRequest.bind(this));
            this.app.delete('/mcp', this.authenticateRequest.bind(this), this.handleMcpDeleteRequest.bind(this));
        }
        else {
            this.app.post('/mcp', this.handleMcpPostRequest.bind(this));
            this.app.get('/mcp', this.handleMcpGetRequest.bind(this));
            this.app.delete('/mcp', this.handleMcpDeleteRequest.bind(this));
        }
        // Error handler
        this.app.use((err, req, res, next) => {
            console.error('HTTP Transport Error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        });
    }
    /**
     * Authenticate request using OAuth2
     */
    async authenticateRequest(req, res, next) {
        if (!this.authenticator) {
            return next();
        }
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                res.status(401).json({ error: 'Missing Authorization header' });
                return;
            }
            const authContext = await this.authenticator.authenticate(authHeader);
            req.auth = authContext;
            next();
        }
        catch (error) {
            console.error('Authentication failed:', error);
            res.status(401).json({ error: 'Authentication failed' });
        }
    }
    /**
     * Set MCP server factory
     */
    setMcpServerFactory(factory) {
        this.mcpServerFactory = factory;
    }
    /**
     * Handle MCP POST request using StreamableHTTPServerTransport
     */
    async handleMcpPostRequest(req, res) {
        try {
            const sessionId = req.headers['mcp-session-id'];
            console.log(sessionId ? `Received MCP POST request for session: ${sessionId}` : 'Received MCP POST request:', req.body);
            if (this.config.oauth?.enabled && req.auth) {
                console.log('Authenticated user:', req.auth);
            }
            let transport;
            if (sessionId && this.transports.has(sessionId)) {
                // Reuse existing transport
                transport = this.transports.get(sessionId);
            }
            else if (!sessionId && isInitializeRequest(req.body)) {
                // New initialization request
                const eventStore = new InMemoryEventStore();
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    eventStore, // Enable resumability
                    onsessioninitialized: (sessionId) => {
                        console.log(`Session initialized with ID: ${sessionId}`);
                        this.transports.set(sessionId, transport);
                    }
                });
                // Set up onclose handler to clean up transport when closed
                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && this.transports.has(sid)) {
                        console.log(`Transport closed for session ${sid}, removing from transports map`);
                        this.transports.delete(sid);
                    }
                };
                // Connect the transport to the MCP server BEFORE handling the request
                if (this.mcpServerFactory) {
                    const server = this.mcpServerFactory();
                    await server.connect(transport);
                }
                else {
                    throw new Error('MCP server factory not initialized');
                }
                await transport.handleRequest(req, res, req.body);
                return; // Already handled
            }
            else {
                // Invalid request - no session ID or not initialization request
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided',
                    },
                    id: null,
                });
                return;
            }
            // Handle the request with existing transport
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            console.error('Error handling MCP POST request:', error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: 'Internal server error',
                    },
                    id: null,
                });
            }
        }
    }
    /**
     * Handle MCP GET request for SSE streams using StreamableHTTPServerTransport
     */
    async handleMcpGetRequest(req, res) {
        try {
            const sessionId = req.headers['mcp-session-id'];
            if (!sessionId || !this.transports.has(sessionId)) {
                res.status(400).send('Invalid or missing session ID');
                return;
            }
            if (this.config.oauth?.enabled && req.auth) {
                console.log('Authenticated SSE connection from user:', req.auth);
            }
            // Check for Last-Event-ID header for resumability
            const lastEventId = req.headers['last-event-id'];
            if (lastEventId) {
                console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
            }
            else {
                console.log(`Establishing new SSE stream for session ${sessionId}`);
            }
            const transport = this.transports.get(sessionId);
            await transport.handleRequest(req, res);
        }
        catch (error) {
            console.error('Error handling MCP GET request:', error);
            if (!res.headersSent) {
                res.status(500).send('Error processing SSE request');
            }
        }
    }
    /**
     * Handle MCP DELETE request for session termination using StreamableHTTPServerTransport
     */
    async handleMcpDeleteRequest(req, res) {
        try {
            const sessionId = req.headers['mcp-session-id'];
            if (!sessionId || !this.transports.has(sessionId)) {
                res.status(400).send('Invalid or missing session ID');
                return;
            }
            console.log(`Received session termination request for session ${sessionId}`);
            const transport = this.transports.get(sessionId);
            await transport.handleRequest(req, res);
        }
        catch (error) {
            console.error('Error handling session termination:', error);
            if (!res.headersSent) {
                res.status(500).send('Error processing session termination');
            }
        }
    }
    /**
     * Start HTTP server
     */
    async start() {
        return new Promise((resolve, reject) => {
            try {
                this.server = createServer(this.app);
                this.server.listen(this.config.port, this.config.host || '0.0.0.0', () => {
                    console.log(`🌐 HTTP Transport listening on ${this.config.host || '0.0.0.0'}:${this.config.port}`);
                    console.log(`📡 MCP endpoint: http://${this.config.host || 'localhost'}:${this.config.port}/mcp`);
                    resolve();
                });
                this.server.on('error', reject);
            }
            catch (error) {
                reject(error);
            }
        });
    }
    /**
     * Stop HTTP server
     */
    async stop() {
        return new Promise((resolve) => {
            if (this.server) {
                // Close all active transports
                for (const [sessionId, transport] of this.transports) {
                    try {
                        console.log(`Closing transport for session ${sessionId}`);
                        transport.close();
                        this.transports.delete(sessionId);
                    }
                    catch (error) {
                        console.error(`Error closing transport for session ${sessionId}:`, error);
                    }
                }
                this.server.close(() => {
                    console.log('🔌 HTTP Transport stopped');
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
    /**
     * Get transport statistics
     */
    getStats() {
        return {
            activeSessions: this.transports.size,
            authEnabled: this.config.oauth?.enabled || false,
        };
    }
    /**
     * Handle OAuth 2.0 Dynamic Client Registration (RFC 7591)
     */
    async handleDynamicClientRegistration(req, res) {
        try {
            console.log('🔐 Dynamic Client Registration request received');
            const { client_name = 'Claude MCP Client', redirect_uris = ['https://claude.ai/api/mcp/auth_callback'], grant_types = ['authorization_code'], response_types = ['code'], scope = 'mcp:read mcp:write mcp:admin' } = req.body;
            // Create the client in Auth0 via Management API
            const clientData = await this.createAuth0Client({
                name: client_name,
                app_type: 'spa', // Single Page Application for public clients
                callbacks: Array.isArray(redirect_uris) ? redirect_uris : [redirect_uris],
                grant_types: Array.isArray(grant_types) ? grant_types : [grant_types],
                token_endpoint_auth_method: 'none'
            });
            console.log(`✅ Client ${clientData.client_id} successfully created in Auth0`);
            const clientRegistration = {
                client_id: clientData.client_id,
                client_name,
                redirect_uris: Array.isArray(redirect_uris) ? redirect_uris : [redirect_uris],
                grant_types: Array.isArray(grant_types) ? grant_types : [grant_types],
                response_types: Array.isArray(response_types) ? response_types : [response_types],
                scope,
                client_id_issued_at: Math.floor(Date.now() / 1000),
                token_endpoint_auth_method: 'none'
            };
            res.status(201).json(clientRegistration);
        }
        catch (error) {
            console.error('❌ DCR registration failed:', error);
            res.status(400).json({
                error: 'invalid_request',
                error_description: `Dynamic client registration failed: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }
    /**
     * Handle OAuth authorization with client mapping
     */
    async handleOAuthAuthorize(req, res) {
        try {
            const { client_id, redirect_uri, state, scope, response_type, code_challenge, code_challenge_method } = req.query;
            console.log(`🔐 OAuth authorize request for client: ${client_id}`);
            if (!client_id || typeof client_id !== 'string') {
                res.status(400).json({ error: 'invalid_request', error_description: 'Invalid client_id' });
                return;
            }
            // Try to find mapped client or create new one
            let mappedClientId = client_id;
            const existingMapping = await this.findMappedClient(client_id);
            if (existingMapping) {
                mappedClientId = existingMapping;
            }
            else {
                // Create new client and store mapping
                const clientData = await this.createAuth0Client({
                    name: `Claude MCP Client (${client_id.substring(0, 8)}...)`,
                    app_type: 'spa', // Single Page Application for public clients
                    callbacks: [redirect_uri || 'https://claude.ai/api/mcp/auth_callback'],
                    grant_types: ['authorization_code'],
                    token_endpoint_auth_method: 'none'
                });
                await this.storeClientMapping(client_id, clientData.client_id);
                mappedClientId = clientData.client_id;
            }
            // Redirect to Auth0 with mapped client ID
            const params = new URLSearchParams({
                response_type: response_type || 'code',
                client_id: mappedClientId,
                redirect_uri: redirect_uri,
                scope: scope || 'mcp:read mcp:write mcp:admin',
                state: state,
                ...(code_challenge && { code_challenge: code_challenge }),
                ...(code_challenge_method && { code_challenge_method: code_challenge_method }),
                ...(this.config.oauth?.audience && { resource: this.config.oauth.audience })
            });
            const auth0Url = `${this.config.oauth?.authorizationEndpoint}?${params.toString()}`;
            res.redirect(auth0Url);
        }
        catch (error) {
            console.error('❌ OAuth authorize error:', error);
            res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
        }
    }
    /**
     * Handle OAuth token exchange with client ID mapping
     */
    async handleTokenProxy(req, res) {
        try {
            const { client_id, code, redirect_uri, grant_type, code_verifier } = req.body;
            if (!client_id) {
                res.status(400).json({ error: 'invalid_request', error_description: 'Missing client_id' });
                return;
            }
            // Find mapped client ID
            const mappedClientId = await this.findMappedClient(client_id);
            if (!mappedClientId) {
                res.status(400).json({ error: 'invalid_client', error_description: 'Client not found' });
                return;
            }
            // Proxy token request to Auth0
            const tokenRequest = {
                grant_type,
                client_id: mappedClientId,
                code,
                redirect_uri,
                code_verifier,
                ...(this.config.oauth?.audience && { audience: this.config.oauth.audience })
            };
            const tokenResponse = await fetch(this.config.oauth.tokenEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: new URLSearchParams(tokenRequest).toString()
            });
            const tokenData = await tokenResponse.json();
            if (tokenResponse.ok) {
                res.json(tokenData);
            }
            else {
                res.status(tokenResponse.status).json(tokenData);
            }
        }
        catch (error) {
            console.error('❌ Token proxy error:', error);
            res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
        }
    }
    // Helper methods for Auth0 client management
    async createAuth0Client(clientData) {
        console.log('🔧 Creating Auth0 client with data:', JSON.stringify(clientData, null, 2));
        const tokenEndpoint = this.config.oauth.issuer.endsWith('/')
            ? `${this.config.oauth.issuer}oauth/token`
            : `${this.config.oauth.issuer}/oauth/token`;
        const tokenResponse = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: this.config.oauth.clientId,
                client_secret: this.config.oauth.clientSecret,
                audience: this.config.oauth.issuer.endsWith('/')
                    ? `${this.config.oauth.issuer}api/v2/`
                    : `${this.config.oauth.issuer}/api/v2/`,
                grant_type: 'client_credentials'
            })
        });
        const tokenData = await tokenResponse.json();
        console.log('✅ Got management API token');
        const clientsEndpoint = this.config.oauth.issuer.endsWith('/')
            ? `${this.config.oauth.issuer}api/v2/clients`
            : `${this.config.oauth.issuer}/api/v2/clients`;
        const createResponse = await fetch(clientsEndpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(clientData)
        });
        if (!createResponse.ok) {
            const errorBody = await createResponse.text();
            console.error('❌ Auth0 client creation failed:', {
                status: createResponse.status,
                statusText: createResponse.statusText,
                body: errorBody
            });
            throw new Error(`Failed to create Auth0 client: ${createResponse.status} - ${errorBody}`);
        }
        const result = await createResponse.json();
        console.log('✅ Auth0 client created:', result.client_id);
        return result;
    }
    async findMappedClient(claudeClientId) {
        // Simple in-memory mapping for demo - in production use Redis/database
        return global.clientMappings?.[claudeClientId] || null;
    }
    async storeClientMapping(claudeClientId, auth0ClientId) {
        // Simple in-memory mapping for demo - in production use Redis/database
        if (!global.clientMappings) {
            global.clientMappings = {};
        }
        global.clientMappings[claudeClientId] = auth0ClientId;
    }
    async verifyClientExists(clientId) {
        // This would check if client exists in Auth0
        // For now, we'll assume it doesn't exist to trigger mapping logic
        throw new Error('Client not found');
    }
}
//# sourceMappingURL=HttpTransport.js.map