/**
 * HTTP Transport for Remote MCP Server using official MCP SDK
 * Uses StreamableHTTPServerTransport for proper MCP protocol compliance
 * Authentication is delegated to the Cloudflare Tunnel/Gateway
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { getSessionStats, registerSessionDirect, isKnownSession } from './session-middleware.js';
export class HttpTransport {
    config;
    app;
    server;
    mcpServerFactory;
    transports = new Map();
    constructor(config) {
        this.config = config;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }
    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        // Trust proxy for Cloudflare Tunnel support
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
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'mcp-session-id', 'last-event-id', 'cf-access-jwt-assertion']
        }));
        // Rate limiting
        this.app.use(rateLimit({
            windowMs: this.config.rateLimit?.windowMs || 15 * 60 * 1000,
            max: this.config.rateLimit?.max || 1000,
            message: 'Too many requests',
            standardHeaders: true,
            legacyHeaders: false
        }));
        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        // Request logging & Identity Extraction
        this.app.use((req, res, next) => {
            const timestamp = new Date().toISOString();
            const cfAssertion = req.headers['cf-access-jwt-assertion'];
            console.log(`${timestamp} ${req.method} ${req.path}`);
            if (cfAssertion) {
                try {
                    const payload = JSON.parse(Buffer.from(cfAssertion.split('.')[1], 'base64').toString());
                    // Log only a redacted prefix of the subject to avoid PII in logs
                    const subPreview = typeof payload.sub === 'string' ? payload.sub.slice(0, 8) + '…' : 'unknown';
                    console.log(`  ↳ Identity: sub=${subPreview}`);
                    req.auth = {
                        isAuthenticated: true,
                        user: {
                            id: payload.sub,
                            email: payload.email,
                            name: payload.name || payload.email
                        }
                    };
                }
                catch (e) {
                    console.warn('  ↳ Failed to parse Cloudflare Identity header');
                }
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
            const stats = getSessionStats();
            res.json({
                status: 'healthy',
                service: 'kms-mcp',
                timestamp: new Date().toISOString(),
                version: '2.0.0',
                sessions: stats,
                auth: 'tunnel-delegated'
            });
        });
        // MCP endpoints - No internal auth, trust the tunnel
        this.app.post('/mcp', this.handleMcpPostRequest.bind(this));
        this.app.get('/mcp', this.handleMcpGetRequest.bind(this));
        this.app.delete('/mcp', this.handleMcpDeleteRequest.bind(this));
        // Generic error handler
        this.app.use((err, req, res, next) => {
            console.error('HTTP Transport Error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        });
    }
    /**
     * Set MCP server factory
     */
    setMcpServerFactory(factory) {
        this.mcpServerFactory = factory;
    }
    /**
     * Wrap a Response so SSE output is collected and returned as a single JSON object.
     * Used for clients (e.g. Anthropic MCP proxy) that send Accept: application/json only.
     */
    wrapResponseForJson(res) {
        let buffer = '';
        let statusCode = 200;
        const capturedHeaders = {};
        const proxy = Object.create(res);
        // Capture status
        proxy.status = (code) => { statusCode = code; return proxy; };
        proxy.writeHead = (code, headers) => {
            statusCode = code;
            if (headers) {
                Object.assign(capturedHeaders, headers);
                // Forward non-SSE headers immediately to the real response
                for (const [key, val] of Object.entries(headers)) {
                    const lower = key.toLowerCase();
                    if (lower !== 'content-type' && lower !== 'cache-control' && lower !== 'connection') {
                        res.setHeader(key, val);
                    }
                }
            }
            return res;
        };
        // Suppress SSE-specific headers; we will set our own Content-Type at the end
        proxy.setHeader = (name, value) => {
            const lower = name.toLowerCase();
            if (lower !== 'content-type' && lower !== 'cache-control' && lower !== 'connection') {
                capturedHeaders[name] = value;
                res.setHeader(name, value);
            }
            return proxy;
        };
        // Buffer SSE chunks
        proxy.write = (chunk) => {
            buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            return true;
        };
        // On end: parse SSE data lines, send as JSON
        proxy.end = (chunk) => {
            if (chunk)
                buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            const messages = [];
            for (const line of buffer.split('\n')) {
                if (line.startsWith('data: ')) {
                    try {
                        messages.push(JSON.parse(line.slice(6)));
                    }
                    catch { /* skip */ }
                }
            }
            const body = messages.length === 1 ? messages[0] : messages.length > 1 ? messages : {};
            console.log(`[json-bridge] SSE→JSON: ${messages.length} message(s), status ${statusCode}`);
            if (!res.headersSent) {
                res.status(statusCode)
                    .header('Content-Type', 'application/json')
                    .json(body);
            }
            return res;
        };
        return proxy;
    }
    /**
     * Handle MCP POST request using StreamableHTTPServerTransport
     */
    async handleMcpPostRequest(req, res) {
        try {
            // Detect JSON-only clients (Anthropic MCP proxy sends Accept: application/json only).
            // The StreamableHTTP SDK requires both application/json AND text/event-stream in Accept.
            // For JSON-only clients: patch the Accept header and wrap res to convert SSE→JSON.
            const accept = (req.headers['accept'] || '');
            const wantsSSE = accept.includes('text/event-stream');
            if (!wantsSSE) {
                req.headers['accept'] = 'application/json, text/event-stream';
                res = this.wrapResponseForJson(res);
                console.log('[json-bridge] JSON-only client detected — SSE→JSON bridge active');
            }
            const sessionId = req.headers['mcp-session-id'];
            if (req.body?.method === 'initialize') {
                const clientInfo = req.body?.params?.clientInfo;
                console.log(`📱 MCP Client connecting:`, {
                    name: clientInfo?.name || 'unknown',
                    version: clientInfo?.version || 'unknown',
                    sessionId: sessionId
                });
            }
            let transport;
            if (sessionId && this.transports.has(sessionId)) {
                transport = this.transports.get(sessionId);
            }
            else if (!sessionId && isInitializeRequest(req.body)) {
                const eventStore = new InMemoryEventStore();
                const userAgent = req.headers['user-agent'] || 'unknown';
                const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    eventStore,
                    onsessioninitialized: (sessionId) => {
                        console.log(`Session initialized: ${sessionId}`);
                        this.transports.set(sessionId, transport);
                        registerSessionDirect(sessionId, 'kms-mcp', userAgent, clientIp);
                    }
                });
                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && this.transports.has(sid)) {
                        this.transports.delete(sid);
                    }
                };
                if (this.mcpServerFactory) {
                    const server = this.mcpServerFactory();
                    await server.connect(transport);
                }
                else {
                    throw new Error('MCP server factory not initialized');
                }
                await transport.handleRequest(req, res, req.body);
                return;
            }
            else if (sessionId && isKnownSession(sessionId)) {
                // Session was valid before server restart but is no longer in memory.
                // Return 404 per MCP spec — client should reinitialize.
                // (Previous code tried to recover by creating a new transport but passed a non-initialize
                // body, causing the transport to return 400, which the Anthropic proxy reported as
                // "Invalid content from server".)
                console.log(`[Transport] Session ${sessionId.substring(0, 8)}... expired after restart — returning 404 to trigger client reinit`);
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: { code: -32001, message: 'Session expired: server restarted. Please reinitialize.' },
                    id: req.body?.id ?? null
                });
                return;
            }
            else {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Bad Request: No valid session ID' },
                    id: null,
                });
                return;
            }
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            console.error('Error handling MCP POST request:', error);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
            }
        }
    }
    async handleMcpGetRequest(req, res) {
        try {
            const sessionId = req.headers['mcp-session-id'];
            if (!sessionId) {
                res.status(400).send('Missing mcp-session-id header');
                return;
            }
            if (!this.transports.has(sessionId)) {
                res.status(404).send('Session not found or expired');
                return;
            }
            const transport = this.transports.get(sessionId);
            await transport.handleRequest(req, res);
        }
        catch (error) {
            console.error('Error handling MCP GET request:', error);
            if (!res.headersSent)
                res.status(500).send('Error processing SSE request');
        }
    }
    async handleMcpDeleteRequest(req, res) {
        try {
            const sessionId = req.headers['mcp-session-id'];
            if (!sessionId) {
                res.status(400).send('Missing mcp-session-id header');
                return;
            }
            if (!this.transports.has(sessionId)) {
                res.status(404).send('Session not found or expired');
                return;
            }
            const transport = this.transports.get(sessionId);
            await transport.handleRequest(req, res);
        }
        catch (error) {
            console.error('Error handling session termination:', error);
            if (!res.headersSent)
                res.status(500).send('Error processing session termination');
        }
    }
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
    async stop() {
        return new Promise((resolve) => {
            if (this.server) {
                for (const [sessionId, transport] of this.transports) {
                    try {
                        transport.close();
                        this.transports.delete(sessionId);
                    }
                    catch (error) { }
                }
                this.server.close(() => { console.log('🔌 HTTP Transport stopped'); resolve(); });
            }
            else
                resolve();
        });
    }
    getStats() {
        return { activeSessions: this.transports.size, auth: 'tunnel-delegated' };
    }
}
