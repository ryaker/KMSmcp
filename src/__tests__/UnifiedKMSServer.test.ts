/**
 * Integration tests for UnifiedKMSServer with OAuth and HTTP transport
 */

import { UnifiedKMSServer } from '../index.js'
import { KMSConfig } from '../types/index.js'

// Mock all external dependencies
jest.mock('ioredis')
jest.mock('../storage/MongoDBStorage.js')
jest.mock('../storage/Neo4jStorage.js')
jest.mock('../storage/Mem0Storage.js')
jest.mock('../transport/HttpTransport.js')

describe('UnifiedKMSServer Integration', () => {
  let server: UnifiedKMSServer
  let config: KMSConfig

  beforeEach(() => {
    config = {
      mongodb: {
        uri: 'mongodb://localhost:27017',
        database: 'test_kms'
      },
      neo4j: {
        uri: 'bolt://localhost:7687',
        username: 'neo4j',
        password: 'password'
      },
      mem0: {
        apiKey: 'test-mem0-key',
        orgId: 'test-org'
      },
      redis: {
        uri: 'redis://localhost:6379'
      },
      fact: {
        l1CacheSize: 10485760, // 10MB
        l2CacheTTL: 300000,    // 5 minutes
        l3CacheTTL: 600000     // 10 minutes
      },
      transport: {
        mode: 'stdio'
      }
    }

    // Mock storage systems
    const mockStorage = {
      initialize: jest.fn().mockResolvedValue(undefined),
      store: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue([]),
      getStats: jest.fn().mockResolvedValue({}),
      close: jest.fn().mockResolvedValue(undefined)
    }

    // Mock Redis
    const mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      keys: jest.fn().mockResolvedValue([]),
      del: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      status: 'ready'
    }

    // Apply mocks
    require('../storage/MongoDBStorage.js').MongoDBStorage.mockImplementation(() => mockStorage)
    require('../storage/Neo4jStorage.js').Neo4jStorage.mockImplementation(() => mockStorage)
    require('../storage/Mem0Storage.js').Mem0Storage.mockImplementation(() => mockStorage)
    require('ioredis').default.mockImplementation(() => mockRedis)
  })

  afterEach(async () => {
    if (server) {
      await server.close()
    }
    jest.clearAllMocks()
  })

  describe('STDIO Transport Mode', () => {
    it('should initialize successfully with STDIO transport', async () => {
      server = new UnifiedKMSServer(config)
      await expect(server.initialize()).resolves.not.toThrow()
    })

    it('should handle MCP tool calls through STDIO', async () => {
      server = new UnifiedKMSServer(config)
      await server.initialize()

      // Access private method for testing
      const authContext = { isAuthenticated: true }
      const request = {
        id: 1,
        method: 'tools/list',
        params: {}
      }

      const result = await (server as any).handleMcpRequest(request, authContext)
      
      expect(result.jsonrpc).toBe('2.0')
      expect(result.result.tools).toBeDefined()
      expect(result.result.tools.length).toBeGreaterThan(0)
      expect(result.id).toBe(1)
    })

    it('should handle unified_store tool call', async () => {
      server = new UnifiedKMSServer(config)
      await server.initialize()

      const authContext = { 
        isAuthenticated: true,
        user: { id: 'test-user' }
      }
      const request = {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'unified_store',
          arguments: {
            content: 'Test knowledge content',
            contentType: 'memory',
            source: 'coaching',
            confidence: 0.9
          }
        }
      }

      const result = await (server as any).handleMcpRequest(request, authContext)
      
      expect(result.jsonrpc).toBe('2.0')
      expect(result.result.content).toBeDefined()
      expect(result.result.content[0].type).toBe('text')
      expect(result.id).toBe(2)
    })
  })

  describe('HTTP Transport Mode', () => {
    beforeEach(() => {
      config.transport = {
        mode: 'http',
        http: {
          port: 3100,
          host: 'localhost'
        }
      }
    })

    it('should initialize successfully with HTTP transport', async () => {
      const mockHttpTransport = {
        setMcpHandler: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn().mockReturnValue({})
      }

      require('../transport/HttpTransport.js').HttpTransport.mockImplementation(() => mockHttpTransport)

      server = new UnifiedKMSServer(config)
      await expect(server.initialize()).resolves.not.toThrow()
      
      expect(mockHttpTransport.setMcpHandler).toHaveBeenCalled()
    })

    it('should throw error when HTTP config is missing', async () => {
      config.transport = { mode: 'http' } // Missing http config

      server = new UnifiedKMSServer(config)
      await expect(server.initialize()).rejects.toThrow('HTTP transport configuration is required')
    })
  })

  describe('Dual Transport Mode', () => {
    beforeEach(() => {
      config.transport = {
        mode: 'dual',
        http: {
          port: 3101,
          host: 'localhost'
        }
      }
    })

    it('should initialize both STDIO and HTTP transports', async () => {
      const mockHttpTransport = {
        setMcpHandler: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn().mockReturnValue({})
      }

      require('../transport/HttpTransport.js').HttpTransport.mockImplementation(() => mockHttpTransport)

      server = new UnifiedKMSServer(config)
      await server.initialize()
      
      expect(mockHttpTransport.setMcpHandler).toHaveBeenCalled()
    })
  })

  describe('OAuth Configuration', () => {
    beforeEach(() => {
      config.transport = {
        mode: 'http',
        http: {
          port: 3102,
          host: 'localhost'
        }
      }
      config.oauth = {
        enabled: true,
        issuer: 'https://auth.example.com',
        audience: 'https://mcp.example.com',
        jwksUri: 'https://auth.example.com/.well-known/jwks.json'
      }
    })

    it('should initialize with OAuth configuration', async () => {
      const mockHttpTransport = {
        setMcpHandler: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn().mockReturnValue({})
      }

      require('../transport/HttpTransport.js').HttpTransport.mockImplementation(() => mockHttpTransport)

      server = new UnifiedKMSServer(config)
      await expect(server.initialize()).resolves.not.toThrow()
    })

    it('should add user context to tool calls when authenticated', async () => {
      const mockHttpTransport = {
        setMcpHandler: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn().mockReturnValue({})
      }

      require('../transport/HttpTransport.js').HttpTransport.mockImplementation(() => mockHttpTransport)

      server = new UnifiedKMSServer(config)
      await server.initialize()

      const authContext = {
        isAuthenticated: true,
        user: { id: 'authenticated-user', email: 'user@example.com' }
      }
      
      const request = {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'unified_store',
          arguments: {
            content: 'Authenticated user content',
            contentType: 'memory',
            source: 'personal'
          }
        }
      }

      const result = await (server as any).handleMcpRequest(request, authContext)
      
      expect(result.jsonrpc).toBe('2.0')
      expect(result.result.content).toBeDefined()
      
      // Verify that the user context was added to the arguments
      const toolArguments = request.params.arguments
      expect(toolArguments.userId).toBe('authenticated-user')
    })
  })

  describe('Error Handling', () => {
    it('should handle unknown tool calls gracefully', async () => {
      server = new UnifiedKMSServer(config)
      await server.initialize()

      const authContext = { isAuthenticated: true }
      const request = {
        id: 4,
        method: 'tools/call',
        params: {
          name: 'unknown_tool',
          arguments: {}
        }
      }

      const result = await (server as any).handleMcpRequest(request, authContext)
      
      expect(result.jsonrpc).toBe('2.0')
      expect(result.error).toBeDefined()
      expect(result.error.code).toBe(-32603)
      expect(result.error.message).toContain('Internal error')
      expect(result.id).toBe(4)
    })

    it('should handle unknown methods gracefully', async () => {
      server = new UnifiedKMSServer(config)
      await server.initialize()

      const authContext = { isAuthenticated: true }
      const request = {
        id: 5,
        method: 'unknown/method',
        params: {}
      }

      const result = await (server as any).handleMcpRequest(request, authContext)
      
      expect(result.jsonrpc).toBe('2.0')
      expect(result.error).toBeDefined()
      expect(result.error.code).toBe(-32601)
      expect(result.error.message).toContain('Method not found')
      expect(result.id).toBe(5)
    })
  })

  describe('Analytics and Cache Management', () => {
    it('should handle get_kms_analytics tool call', async () => {
      server = new UnifiedKMSServer(config)
      await server.initialize()

      const authContext = { isAuthenticated: true }
      const request = {
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_kms_analytics',
          arguments: {
            timeRange: '24h',
            includeCache: true
          }
        }
      }

      const result = await (server as any).handleMcpRequest(request, authContext)
      
      expect(result.jsonrpc).toBe('2.0')
      expect(result.result.content).toBeDefined()
      expect(result.result.content[0].type).toBe('text')
      
      const analytics = JSON.parse(result.result.content[0].text)
      expect(analytics.timestamp).toBeDefined()
      expect(analytics.cache).toBeDefined()
      expect(analytics.systems).toBeDefined()
      expect(analytics.overall).toBeDefined()
    })

    it('should handle cache_invalidate tool call', async () => {
      server = new UnifiedKMSServer(config)
      await server.initialize()

      const authContext = { isAuthenticated: true }
      const request = {
        id: 7,
        method: 'tools/call',
        params: {
          name: 'cache_invalidate',
          arguments: {
            pattern: 'test:*',
            level: 'all'
          }
        }
      }

      const result = await (server as any).handleMcpRequest(request, authContext)
      
      expect(result.jsonrpc).toBe('2.0')
      expect(result.result.content).toBeDefined()
      
      const cacheResult = JSON.parse(result.result.content[0].text)
      expect(cacheResult.success).toBe(true)
      expect(cacheResult.pattern).toBe('test:*')
      expect(cacheResult.level).toBe('all')
    })
  })
})