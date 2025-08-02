/**
 * OAuth 2.1 Authenticator for Remote MCP Server
 * Implements JWT validation, token introspection, and resource protection
 */
import { OAuthConfig, AuthContext } from './types.js';
export declare class OAuth2Authenticator {
    private config;
    private jwksClient?;
    private cache;
    constructor(config: OAuthConfig);
    /**
     * Authenticate request using Bearer token
     */
    authenticate(authHeader?: string): Promise<AuthContext>;
    /**
     * Validate JWT token using JWKS
     */
    private validateJWT;
    /**
     * Get signing key from JWKS endpoint
     */
    private getSigningKey;
    /**
     * Introspect token at authorization server
     */
    private introspectToken;
    /**
     * Check if user has required scope
     */
    hasScope(context: AuthContext, requiredScope: string): boolean;
    /**
     * Create standardized OAuth error
     */
    private createAuthError;
    /**
     * Clear authentication cache
     */
    clearCache(): void;
    /**
     * Get cache statistics
     */
    getCacheStats(): {
        size: number;
        hitRate?: number;
    };
}
//# sourceMappingURL=OAuth2Authenticator.d.ts.map