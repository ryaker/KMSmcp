import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import cors from 'cors'
import helmet from 'helmet'
import jwt from 'jsonwebtoken'

const app = express()
const PORT = process.env.PORT || 80

// Security
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}))

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'mcp-session-id', 'last-event-id']
}))

// MCP Service Registry with Auth Requirements
const MCP_SERVICES = {
  kms: {
    target: process.env.KMS_MCP_URL || 'http://kms-mcp:3001',
    name: 'Unified KMS',
    description: 'Unified Knowledge Management System',
    requiresAuth: true, // This service requires OAuth
    audience: process.env.KMS_AUDIENCE || 'https://mcp.yaker.org/kms'
  },
  coaching: {
    target: process.env.COACHING_MCP_URL || 'http://coaching-mcp:3002',
    name: 'Coaching Admin',
    description: 'Coaching Clone Administration',
    requiresAuth: true,
    audience: process.env.COACHING_AUDIENCE || 'https://mcp.yaker.org/coaching'
  },
  mongodb: {
    target: process.env.MONGODB_MCP_URL || 'http://mongodb-mcp:3003',
    name: 'MongoDB Personal',
    description: 'Personal MongoDB Storage',
    requiresAuth: true,
    audience: process.env.MONGODB_AUDIENCE || 'https://mcp.yaker.org/mongodb'
  },
  neo4j: {
    target: process.env.NEO4J_MCP_URL || 'http://neo4j-mcp:3004',
    name: 'Neo4j Knowledge',
    description: 'Neo4j Knowledge Graph',
    requiresAuth: true,
    audience: process.env.NEO4J_AUDIENCE || 'https://mcp.yaker.org/neo4j'
  }
}

// OAuth Configuration (shared across all services)
const OAUTH_CONFIG = {
  enabled: process.env.OAUTH_ENABLED === 'true',
  issuer: process.env.OAUTH_ISSUER,
  jwksUri: process.env.OAUTH_JWKS_URI,
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET
}

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    services: Object.keys(MCP_SERVICES),
    oauth: OAUTH_CONFIG.enabled ? 'enabled' : 'disabled'
  })
})

// Service directory (no auth required) 
app.get('/directory', (req, res) => {
  const directory = {}
  for (const [key, service] of Object.entries(MCP_SERVICES)) {
    directory[key] = {
      name: service.name,
      url: `https://mcp.yaker.org/${key}/mcp`,
      description: service.description,
      requiresAuth: service.requiresAuth,
      audience: service.audience
    }
  }
  res.json({ 
    services: directory,
    authentication: {
      enabled: OAUTH_CONFIG.enabled,
      issuer: OAUTH_CONFIG.issuer,
      audiences: Object.values(MCP_SERVICES).map(s => s.audience)
    }
  })
})

// OAuth metadata endpoints (RFC 8414)
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  if (!OAUTH_CONFIG.enabled) {
    return res.status(404).json({ error: 'OAuth not enabled' })
  }
  
  res.json({
    issuer: OAUTH_CONFIG.issuer,
    authorization_endpoint: `${OAUTH_CONFIG.issuer}/authorize`,
    token_endpoint: `${OAUTH_CONFIG.issuer}/oauth/token`,
    jwks_uri: OAUTH_CONFIG.jwksUri,
    response_types_supported: ['code', 'token'],
    grant_types_supported: ['authorization_code', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    service_documentation: 'https://mcp.yaker.org/docs'
  })
})

// Create OAuth-aware proxy middleware
const createMCPProxy = (serviceName, serviceConfig) => {
  return createProxyMiddleware({
    target: serviceConfig.target,
    changeOrigin: true,
    ws: true,
    logLevel: 'info',
    
    // CRITICAL: Preserve OAuth headers
    onProxyReq: (proxyReq, req, res) => {
      // Forward the Authorization header unchanged
      if (req.headers.authorization) {
        proxyReq.setHeader('Authorization', req.headers.authorization)
      }
      
      // Forward MCP session headers
      if (req.headers['mcp-session-id']) {
        proxyReq.setHeader('mcp-session-id', req.headers['mcp-session-id'])
      }
      
      // Forward SSE headers
      if (req.headers.accept?.includes('text/event-stream')) {
        proxyReq.setHeader('Accept', 'text/event-stream')
      }
      
      // Add service-specific audience hint for the backend
      if (serviceConfig.requiresAuth && OAUTH_CONFIG.enabled) {
        proxyReq.setHeader('X-OAuth-Audience', serviceConfig.audience)
      }
      
      // Log auth forwarding for debugging
      console.log(`[${serviceName}] Forwarding request:`, {
        path: req.path,
        hasAuth: !!req.headers.authorization,
        sessionId: req.headers['mcp-session-id']
      })
    },
    
    onProxyRes: (proxyRes, req, res) => {
      // Disable buffering for SSE
      if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
        res.setHeader('X-Accel-Buffering', 'no')
        res.setHeader('Cache-Control', 'no-cache')
      }
      
      // Forward any OAuth challenge headers
      if (proxyRes.headers['www-authenticate']) {
        res.setHeader('WWW-Authenticate', proxyRes.headers['www-authenticate'])
      }
    },
    
    onError: (err, req, res) => {
      console.error(`[${serviceName}] Proxy error:`, err)
      
      // Check if it's an auth error from the backend
      if (err.code === 'ECONNREFUSED') {
        res.status(503).json({ 
          error: 'Service Unavailable',
          message: `${serviceConfig.name} is currently unavailable`,
          service: serviceName
        })
      } else {
        res.status(502).json({ 
          error: 'Bad Gateway',
          message: err.message,
          service: serviceName
        })
      }
    }
  })
}

// Default route to KMS MCP (preserves OAuth)
app.use('/mcp', createMCPProxy('kms', MCP_SERVICES.kms))

// Service-specific routes (all preserve OAuth)
for (const [key, service] of Object.entries(MCP_SERVICES)) {
  app.use(`/${key}`, createMCPProxy(key, service))
}

// Root redirect to directory
app.get('/', (req, res) => {
  res.redirect('/directory')
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'MCP service not found',
    availableServices: Object.keys(MCP_SERVICES)
  })
})

app.listen(PORT, () => {
  console.log(`🚀 MCP OAuth-Aware Gateway running on port ${PORT}`)
  console.log(`📍 Domain: mcp.yaker.org`)
  console.log(`🔐 OAuth: ${OAUTH_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`)
  console.log(`🔧 Services:`)
  for (const [key, service] of Object.entries(MCP_SERVICES)) {
    console.log(`   - /${key} → ${service.name} ${service.requiresAuth ? '🔒' : ''}`)
  }
})