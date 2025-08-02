/**
 * OAuth 2.1 Authenticator for Remote MCP Server
 * Implements JWT validation, token introspection, and resource protection
 */

import jwt, { JwtPayload } from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import fetch from 'node-fetch'
import {
  OAuthConfig,
  AuthContext,
  JWTPayload,
  TokenIntrospectionRequest,
  TokenIntrospectionResponse,
  OAuthError
} from './types.js'

export class OAuth2Authenticator {
  private jwksClient?: jwksClient.JwksClient
  private cache = new Map<string, { context: AuthContext, expires: number }>()
  
  constructor(private config: OAuthConfig) {
    if (config.enabled && config.jwksUri) {
      this.jwksClient = jwksClient({
        jwksUri: config.jwksUri,
        cache: true,
        cacheMaxAge: 600000, // 10 minutes
        rateLimit: true,
        jwksRequestsPerMinute: 10
      })
    }
  }

  /**
   * Authenticate request using Bearer token
   */
  async authenticate(authHeader?: string): Promise<AuthContext> {
    if (!this.config.enabled) {
      return { isAuthenticated: true } // Auth disabled, allow all
    }

    if (!authHeader) {
      throw this.createAuthError('invalid_request', 'Missing Authorization header')
    }

    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      throw this.createAuthError('invalid_request', 'Invalid Authorization header format')
    }

    const token = parts[1]
    
    // Check cache first
    const cached = this.cache.get(token)
    if (cached && cached.expires > Date.now()) {
      return cached.context
    }

    let context: AuthContext

    try {
      // Try JWT validation first (faster)
      context = await this.validateJWT(token)
    } catch (jwtError) {
      console.log('JWT validation failed, trying token introspection:', jwtError instanceof Error ? jwtError.message : String(jwtError))
      
      try {
        // Fallback to token introspection
        context = await this.introspectToken(token)
      } catch (introspectionError) {
        console.error('Token introspection failed:', introspectionError instanceof Error ? introspectionError.message : String(introspectionError))
        throw this.createAuthError('invalid_token', 'Token validation failed')
      }
    }

    // Cache successful authentication for 5 minutes
    this.cache.set(token, {
      context,
      expires: Date.now() + 300000
    })

    return context
  }

  /**
   * Validate JWT token using JWKS
   */
  private async validateJWT(token: string): Promise<AuthContext> {
    if (!this.jwksClient) {
      throw new Error('JWKS client not configured')
    }

    return new Promise((resolve, reject) => {
      jwt.verify(token, this.getSigningKey.bind(this), {
        audience: this.config.audience,
        issuer: this.config.issuer,
        algorithms: ['RS256', 'ES256']
      }, (err: any, decoded: any) => {
        if (err) {
          reject(err)
          return
        }

        const payload = decoded as JWTPayload
        
        // Validate required claims
        if (!payload.sub || !payload.aud || !payload.iss) {
          reject(new Error('Missing required JWT claims'))
          return
        }

        // Validate audience and resource parameter
        if (payload.aud !== this.config.audience) {
          reject(new Error('Invalid audience'))
          return
        }

        resolve({
          isAuthenticated: true,
          user: {
            id: payload.sub,
            email: payload.email,
            name: payload.name,
            roles: payload.roles || []
          },
          token: {
            type: 'Bearer',
            value: token,
            scope: payload.scope,
            expiresAt: new Date(payload.exp * 1000)
          },
          client: payload.client_id ? {
            id: payload.client_id
          } : undefined
        })
      })
    })
  }

  /**
   * Get signing key from JWKS endpoint
   */
  private async getSigningKey(header: jwt.JwtHeader): Promise<string> {
    if (!this.jwksClient) {
      throw new Error('JWKS client not configured')
    }

    return new Promise((resolve, reject) => {
      this.jwksClient!.getSigningKey(header.kid, (err: any, key: any) => {
        if (err) {
          reject(err)
          return
        }
        resolve(key.getPublicKey())
      })
    })
  }

  /**
   * Introspect token at authorization server
   */
  private async introspectToken(token: string): Promise<AuthContext> {
    // For Auth0, use the userinfo endpoint to validate opaque access tokens
    const userinfoEndpoint = this.config.issuer.endsWith('/') 
      ? this.config.issuer + 'userinfo' 
      : this.config.issuer + '/userinfo'
    
    console.log(`🔍 Using Auth0 userinfo endpoint for token validation: ${userinfoEndpoint}`)

    try {
      const response = await fetch(userinfoEndpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Userinfo request failed: ${response.status} ${response.statusText}`)
      }

      const userinfo = await response.json() as any
      console.log(`✅ Token validation successful via userinfo endpoint`)
      console.log(`  ↳ User ID: ${userinfo.sub}`)
      console.log(`  ↳ Email: ${userinfo.email || 'N/A'}`)

      return {
        isAuthenticated: true,
        user: {
          id: userinfo.sub || 'unknown',
          email: userinfo.email,
          name: userinfo.name || userinfo.nickname,
          roles: []
        },
        token: {
          type: 'Bearer',
          value: token,
          scope: 'mcp:read mcp:write mcp:admin', // Assume full access for valid tokens
          expiresAt: undefined // Auth0 userinfo doesn't return expiry
        }
      }
    } catch (error) {
      console.error(`❌ Token introspection via userinfo failed:`, error instanceof Error ? error.message : String(error))
      throw new Error('Token validation failed')
    }
  }

  /**
   * Check if user has required scope
   */
  hasScope(context: AuthContext, requiredScope: string): boolean {
    if (!this.config.enabled) return true
    
    const scopes = context.token?.scope?.split(' ') || []
    return scopes.includes(requiredScope)
  }

  /**
   * Create standardized OAuth error
   */
  private createAuthError(error: string, description?: string): Error {
    const authError = new Error(description || error) as Error & { oauth: OAuthError }
    authError.oauth = {
      error,
      error_description: description
    }
    return authError
  }

  /**
   * Clear authentication cache
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number, hitRate?: number } {
    return {
      size: this.cache.size
    }
  }
}