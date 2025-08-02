/**
 * Unit tests for HttpTransport
 */

import request from 'supertest'
import { HttpTransport, HttpTransportConfig } from '../../transport/HttpTransport.js'
import { AuthContext } from '../../auth/types.js'

// Mock dependencies
jest.mock('../../auth/OAuth2Authenticator.js')

describe('HttpTransport', () => {
  let transport: HttpTransport
  let config: HttpTransportConfig

  beforeEach(() => {
    config = {
      port: 3002,
      host: 'localhost',
      cors: {
        origin: true,
        credentials: true
      },
      rateLimit: {
        windowMs: 15 * 60 * 1000,
        max: 100
      }
    }

    transport = new HttpTransport(config)
  })

  afterEach(async () => {
    await transport.stop()
  })

  describe('Health endpoint', () => {
    it('should respond with health status', async () => {
      await transport.start()
      
      const response = await request(transport['app'])
        .get('/health')
        .expect(200)

      expect(response.body).toMatchObject({
        status: 'healthy',
        version: '2.0.0'
      })
      expect(response.body.timestamp).toBeDefined()
    })
  })

  describe('OAuth Protected Resource Metadata', () => {
    it('should return 404 when OAuth is not enabled', async () => {
      await transport.start()
      
      await request(transport['app'])
        .get('/.well-known/oauth-protected-resource')
        .expect(404)
    })

    it('should return metadata when OAuth is enabled', async () => {
      const oauthConfig = {
        ...config,
        port: 3003,
        oauth: {
          enabled: true,
          issuer: 'https://auth.example.com',
          audience: 'https://mcp.example.com',
          jwksUri: 'https://auth.example.com/.well-known/jwks.json'
        }
      }

      const oauthTransport = new HttpTransport(oauthConfig)
      await oauthTransport.start()

      const response = await request(oauthTransport['app'])
        .get('/.well-known/oauth-protected-resource')
        .expect(200)

      expect(response.body).toMatchObject({
        resource: 'https://mcp.example.com',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
        bearer_methods_supported: ['header']
      })

      await oauthTransport.stop()
    })
  })

  describe('MCP endpoint without OAuth', () => {
    beforeEach(async () => {
      await transport.start()
      
      // Set up a mock MCP handler
      transport.setMcpHandler(async (request: any, context: AuthContext) => {
        return {
          jsonrpc: '2.0',
          result: { message: 'success', user: context.user?.id },
          id: request.id
        }
      })
    })

    it('should handle MCP requests without authentication', async () => {
      const mcpRequest = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1
      }

      const response = await request(transport['app'])
        .post('/mcp')
        .send(mcpRequest)
        .expect(200)

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        result: { message: 'success' },
        id: 1
      })
    })

    it('should handle malformed JSON', async () => {
      await request(transport['app'])
        .post('/mcp')
        .send('invalid json')
        .expect(400)
    })

    it('should return 503 when MCP handler is not set', async () => {
      const noHandlerTransport = new HttpTransport(config)
      await noHandlerTransport.start()

      const mcpRequest = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1
      }

      const response = await request(noHandlerTransport['app'])
        .post('/mcp')
        .send(mcpRequest)
        .expect(503)

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'MCP handler not initialized'
        },
        id: 1
      })

      await noHandlerTransport.stop()
    })
  })

  describe('MCP endpoint with OAuth', () => {
    let oauthTransport: HttpTransport

    beforeEach(async () => {
      const oauthConfig = {
        ...config,
        port: 3004, // Use different port to avoid conflicts
        oauth: {
          enabled: true,
          issuer: 'https://auth.example.com',
          audience: 'https://mcp.example.com',
          jwksUri: 'https://auth.example.com/.well-known/jwks.json'
        }
      }

      oauthTransport = new HttpTransport(oauthConfig)
      await oauthTransport.start()

      // Mock the authenticator
      const mockAuth = {
        authenticate: jest.fn()
      }
      oauthTransport['authenticator'] = mockAuth as any

      // Set up a mock MCP handler
      oauthTransport.setMcpHandler(async (request: any, context: AuthContext) => {
        return {
          jsonrpc: '2.0',
          result: { message: 'authenticated', user: context.user?.id },
          id: request.id
        }
      })
    })

    afterEach(async () => {
      await oauthTransport.stop()
    })

    it('should return 401 when no authorization header is provided', async () => {
      const mockAuth = oauthTransport['authenticator']
      mockAuth!.authenticate = jest.fn().mockRejectedValue({
        oauth: {
          error: 'invalid_request',
          error_description: 'Missing Authorization header'
        }
      })

      const mcpRequest = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1
      }

      const response = await request(oauthTransport['app'])
        .post('/mcp')
        .send(mcpRequest)
        .expect(401)

      expect(response.headers['www-authenticate']).toContain('Bearer')
      expect(response.headers['www-authenticate']).toContain('resource_metadata')
      expect(response.body.error).toBe('invalid_request')
    })

    it('should authenticate valid Bearer token', async () => {
      const mockAuth = oauthTransport['authenticator']
      mockAuth!.authenticate = jest.fn().mockResolvedValue({
        isAuthenticated: true,
        user: { id: 'user123', email: 'user@example.com' }
      })

      const mcpRequest = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1
      }

      const response = await request(oauthTransport['app'])
        .post('/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send(mcpRequest)
        .expect(200)

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        result: { message: 'authenticated', user: 'user123' },
        id: 1
      })
    })

    it('should return 401 for invalid Bearer token', async () => {
      const mockAuth = oauthTransport['authenticator']
      mockAuth!.authenticate = jest.fn().mockRejectedValue({
        oauth: {
          error: 'invalid_token',
          error_description: 'Token validation failed'
        }
      })

      const mcpRequest = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1
      }

      const response = await request(oauthTransport['app'])
        .post('/mcp')
        .set('Authorization', 'Bearer invalid-token')
        .send(mcpRequest)
        .expect(401)

      expect(response.body.error).toBe('invalid_token')
    })
  })

  describe('Server-Sent Events', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should establish SSE connection', (done) => {
      const req = request(transport['app'])
        .get('/mcp/events')
        .set('Accept', 'text/event-stream')
        .buffer(false)
        .parse((res, callback) => {
          res.on('data', (chunk) => {
            const data = chunk.toString()
            if (data.includes('connected')) {
              const event = JSON.parse(data.replace('data: ', '').trim())
              expect(event.type).toBe('connected')
              expect(event.clientId).toBeDefined()
              callback(null, event)
              done()
            }
          })
        })

      req.end()
    })

    it('should broadcast events to connected clients', (done) => {
      let clientConnected = false
      
      const req = request(transport['app'])
        .get('/mcp/events')
        .set('Accept', 'text/event-stream')
        .buffer(false)
        .parse((res, callback) => {
          res.on('data', (chunk) => {
            const data = chunk.toString()
            
            if (data.includes('connected') && !clientConnected) {
              clientConnected = true
              // Broadcast an event after connection
              setTimeout(() => {
                transport.broadcastEvent({
                  type: 'test',
                  data: { message: 'hello' }
                })
              }, 100)
            } else if (data.includes('test')) {
              const event = JSON.parse(data.replace('data: ', '').trim())
              expect(event.type).toBe('test')
              expect(event.data.message).toBe('hello')
              callback(null, event)
              done()
            }
          })
        })

      req.end()
    })
  })

  describe('Rate limiting', () => {
    beforeEach(async () => {
      // Create transport with very low rate limit for testing
      const rateLimitConfig = {
        ...config,
        port: 3005,
        rateLimit: {
          windowMs: 60000, // 1 minute
          max: 2 // Only 2 requests per minute
        }
      }

      transport = new HttpTransport(rateLimitConfig)
      await transport.start()
    })

    it('should enforce rate limits', async () => {
      // First two requests should succeed
      await request(transport['app'])
        .get('/health')
        .expect(200)

      await request(transport['app'])
        .get('/health')
        .expect(200)

      // Third request should be rate limited
      await request(transport['app'])
        .get('/health')
        .expect(429)
    })
  })

  describe('Statistics', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should return transport statistics', () => {
      const stats = transport.getStats()
      
      expect(stats).toHaveProperty('sseClients')
      expect(stats).toHaveProperty('authEnabled')
      expect(typeof stats.sseClients).toBe('number')
      expect(typeof stats.authEnabled).toBe('boolean')
    })
  })
})