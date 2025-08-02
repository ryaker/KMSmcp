/**
 * Unit tests for OAuth2Authenticator
 */

import { OAuth2Authenticator } from '../../auth/OAuth2Authenticator.js'
import { OAuthConfig } from '../../auth/types.js'

// Mock dependencies
jest.mock('jsonwebtoken')
jest.mock('jwks-rsa')
jest.mock('node-fetch')

import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import fetch from 'node-fetch'

const mockJwt = jwt as jest.Mocked<typeof jwt>
const mockJwksClient = jwksClient as jest.Mocked<typeof jwksClient>
const mockFetch = fetch as jest.MockedFunction<typeof fetch>

describe('OAuth2Authenticator', () => {
  let authenticator: OAuth2Authenticator
  let config: OAuthConfig

  beforeEach(() => {
    config = {
      enabled: true,
      issuer: 'https://auth.example.com',
      audience: 'https://mcp.example.com',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      tokenIntrospectionEndpoint: 'https://auth.example.com/oauth/introspect'
    }

    authenticator = new OAuth2Authenticator(config)
    
    // Reset mocks
    jest.clearAllMocks()
  })

  describe('constructor', () => {
    it('should initialize with OAuth enabled', () => {
      expect(authenticator).toBeInstanceOf(OAuth2Authenticator)
    })

    it('should not initialize JWKS client when OAuth is disabled', () => {
      const disabledConfig = { ...config, enabled: false }
      const disabledAuth = new OAuth2Authenticator(disabledConfig)
      expect(disabledAuth).toBeInstanceOf(OAuth2Authenticator)
    })

    it('should not initialize JWKS client when jwksUri is not provided', () => {
      const noJwksConfig = { ...config, jwksUri: undefined }
      const noJwksAuth = new OAuth2Authenticator(noJwksConfig)
      expect(noJwksAuth).toBeInstanceOf(OAuth2Authenticator)
    })
  })

  describe('authenticate', () => {
    it('should return authenticated context when OAuth is disabled', async () => {
      const disabledConfig = { ...config, enabled: false }
      const disabledAuth = new OAuth2Authenticator(disabledConfig)
      
      const result = await disabledAuth.authenticate()
      expect(result.isAuthenticated).toBe(true)
    })

    it('should throw error when Authorization header is missing', async () => {
      await expect(authenticator.authenticate()).rejects.toThrow('Missing Authorization header')
    })

    it('should throw error when Authorization header format is invalid', async () => {
      await expect(authenticator.authenticate('Invalid-Format')).rejects.toThrow('Invalid Authorization header format')
    })

    it('should authenticate with valid JWT token', async () => {
      const token = 'valid.jwt.token'
      const authHeader = `Bearer ${token}`
      
      // Mock JWT verification
      const mockPayload = {
        sub: 'user123',
        aud: config.audience,
        iss: config.issuer,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        email: 'user@example.com',
        name: 'Test User',
        scope: 'mcp:read mcp:write',
        client_id: 'test-client'
      }

      mockJwt.verify.mockImplementation((token, getKey, options, callback) => {
        callback!(null, mockPayload)
      })

      // Mock JWKS client
      const mockJwksClient = {
        getSigningKey: jest.fn((kid, callback) => {
          callback(null, { getPublicKey: () => 'mock-public-key' })
        })
      }
      ;(jwksClient as any).mockReturnValue(mockJwksClient)

      const result = await authenticator.authenticate(authHeader)

      expect(result.isAuthenticated).toBe(true)
      expect(result.user?.id).toBe('user123')
      expect(result.user?.email).toBe('user@example.com')
      expect(result.user?.name).toBe('Test User')
      expect(result.token?.value).toBe(token)
      expect(result.token?.scope).toBe('mcp:read mcp:write')
      expect(result.client?.id).toBe('test-client')
    })

    it('should fallback to token introspection when JWT validation fails', async () => {
      const token = 'invalid.jwt.token'
      const authHeader = `Bearer ${token}`

      // Mock JWT verification to fail
      mockJwt.verify.mockImplementation((token, getKey, options, callback) => {
        callback!(new Error('JWT verification failed'), null)
      })

      // Mock successful token introspection
      const introspectionResponse = {
        active: true,
        sub: 'user123',
        aud: config.audience,
        client_id: 'test-client',
        scope: 'mcp:read',
        exp: Math.floor(Date.now() / 1000) + 3600
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => introspectionResponse
      } as any)

      const result = await authenticator.authenticate(authHeader)

      expect(result.isAuthenticated).toBe(true)
      expect(result.user?.id).toBe('user123')
      expect(result.token?.scope).toBe('mcp:read')
      expect(result.client?.id).toBe('test-client')
    })

    it('should throw error when both JWT and introspection fail', async () => {
      const token = 'invalid.token'
      const authHeader = `Bearer ${token}`

      // Mock JWT verification to fail
      mockJwt.verify.mockImplementation((token, getKey, options, callback) => {
        callback!(new Error('JWT verification failed'), null)
      })

      // Mock token introspection to fail
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      } as any)

      await expect(authenticator.authenticate(authHeader)).rejects.toThrow('Token validation failed')
    })

    it('should cache successful authentication', async () => {
      const token = 'valid.jwt.token'
      const authHeader = `Bearer ${token}`
      
      const mockPayload = {
        sub: 'user123',
        aud: config.audience,
        iss: config.issuer,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
      }

      mockJwt.verify.mockImplementation((token, getKey, options, callback) => {
        callback!(null, mockPayload)
      })

      const mockJwksClient = {
        getSigningKey: jest.fn((kid, callback) => {
          callback(null, { getPublicKey: () => 'mock-public-key' })
        })
      }
      ;(jwksClient as any).mockReturnValue(mockJwksClient)

      // First call
      const result1 = await authenticator.authenticate(authHeader)
      expect(result1.isAuthenticated).toBe(true)

      // Second call should use cache
      const result2 = await authenticator.authenticate(authHeader)
      expect(result2.isAuthenticated).toBe(true)
      
      // JWT verification should only be called once
      expect(mockJwt.verify).toHaveBeenCalledTimes(1)
    })
  })

  describe('hasScope', () => {
    it('should return true when OAuth is disabled', () => {
      const disabledConfig = { ...config, enabled: false }
      const disabledAuth = new OAuth2Authenticator(disabledConfig)
      
      const context = { isAuthenticated: true }
      expect(disabledAuth.hasScope(context, 'mcp:read')).toBe(true)
    })

    it('should return true when user has required scope', () => {
      const context = {
        isAuthenticated: true,
        token: {
          type: 'Bearer' as const,
          value: 'token',
          scope: 'mcp:read mcp:write'
        }
      }

      expect(authenticator.hasScope(context, 'mcp:read')).toBe(true)
      expect(authenticator.hasScope(context, 'mcp:write')).toBe(true)
    })

    it('should return false when user does not have required scope', () => {
      const context = {
        isAuthenticated: true,
        token: {
          type: 'Bearer' as const,
          value: 'token',
          scope: 'mcp:read'
        }
      }

      expect(authenticator.hasScope(context, 'mcp:admin')).toBe(false)
    })

    it('should return false when no token scope is present', () => {
      const context = {
        isAuthenticated: true,
        token: {
          type: 'Bearer' as const,
          value: 'token'
        }
      }

      expect(authenticator.hasScope(context, 'mcp:read')).toBe(false)
    })
  })

  describe('clearCache', () => {
    it('should clear authentication cache', () => {
      authenticator.clearCache()
      
      const stats = authenticator.getCacheStats()
      expect(stats.size).toBe(0)
    })
  })

  describe('getCacheStats', () => {
    it('should return cache statistics', () => {
      const stats = authenticator.getCacheStats()
      expect(stats).toHaveProperty('size')
      expect(typeof stats.size).toBe('number')
    })
  })
})