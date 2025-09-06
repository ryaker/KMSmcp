import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import cors from 'cors'
import helmet from 'helmet'

const app = express()
const PORT = process.env.PORT || 80

// Security
app.use(helmet())
app.use(cors())

// MCP Service Registry
const MCP_SERVICES = {
  kms: {
    target: process.env.KMS_MCP_URL || 'http://kms-mcp:3001',
    name: 'Unified KMS',
    description: 'Unified Knowledge Management System'
  },
  coaching: {
    target: process.env.COACHING_MCP_URL || 'http://coaching-mcp:3002',
    name: 'Coaching Admin',
    description: 'Coaching Clone Administration'
  },
  mongodb: {
    target: process.env.MONGODB_MCP_URL || 'http://mongodb-mcp:3003',
    name: 'MongoDB Personal',
    description: 'Personal MongoDB Storage'
  },
  neo4j: {
    target: process.env.NEO4J_MCP_URL || 'http://neo4j-mcp:3004',
    name: 'Neo4j Knowledge',
    description: 'Neo4j Knowledge Graph'
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', services: Object.keys(MCP_SERVICES) })
})

// Service directory
app.get('/directory', (req, res) => {
  const directory = {}
  for (const [key, service] of Object.entries(MCP_SERVICES)) {
    directory[key] = {
      name: service.name,
      url: `https://mcp.yaker.org/${key}/mcp`,
      description: service.description
    }
  }
  res.json({ services: directory })
})

// Create proxy middleware with SSE support
const createMCPProxy = (target) => {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true, // WebSocket support
    logLevel: 'info',
    onError: (err, req, res) => {
      console.error('Proxy error:', err)
      res.status(502).json({ error: 'Bad Gateway', message: err.message })
    },
    onProxyReq: (proxyReq, req, res) => {
      // Ensure SSE headers are preserved
      if (req.headers.accept?.includes('text/event-stream')) {
        proxyReq.setHeader('Accept', 'text/event-stream')
      }
    },
    onProxyRes: (proxyRes, req, res) => {
      // Disable buffering for SSE
      if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
        res.setHeader('X-Accel-Buffering', 'no')
        res.setHeader('Cache-Control', 'no-cache')
      }
    }
  })
}

// Default route to KMS MCP
app.use('/mcp', createMCPProxy(MCP_SERVICES.kms.target))

// Service-specific routes
for (const [key, service] of Object.entries(MCP_SERVICES)) {
  app.use(`/${key}`, createMCPProxy(service.target))
}

// Root redirect to directory
app.get('/', (req, res) => {
  res.redirect('/directory')
})

app.listen(PORT, () => {
  console.log(`🚀 MCP Gateway running on port ${PORT}`)
  console.log(`📍 Domain: mcp.yaker.org`)
  console.log(`🔧 Services:`)
  for (const [key, service] of Object.entries(MCP_SERVICES)) {
    console.log(`   - /${key} → ${service.name}`)
  }
})