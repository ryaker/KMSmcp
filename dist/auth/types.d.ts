/**
 * OAuth 2.1 and Authentication Types for Remote MCP
 * Based on RFC 8414, RFC 7591, RFC 9728, and reference implementations
 */
export interface OAuthConfig {
    enabled: boolean;
    issuer: string;
    audience: string;
    clientId?: string;
    clientSecret?: string;
    jwksUri?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    tokenIntrospectionEndpoint?: string;
    userInfoEndpoint?: string;
    dynamicRegistration?: {
        enabled: boolean;
        endpoint?: string;
    };
}
export interface JWTPayload {
    iss: string;
    sub: string;
    aud: string;
    exp: number;
    iat: number;
    nbf?: number;
    scope?: string;
    client_id?: string;
    resource?: string;
    email?: string;
    name?: string;
    roles?: string[];
}
export interface AuthContext {
    isAuthenticated: boolean;
    user?: {
        id: string;
        email?: string;
        name?: string;
        roles?: string[];
    };
    token?: {
        type: 'Bearer';
        value: string;
        scope?: string;
        expiresAt?: Date;
    };
    client?: {
        id: string;
        name?: string;
    };
}
export interface ProtectedResourceMetadata {
    resource: string;
    authorization_servers: string[];
    scopes_supported?: string[];
    bearer_methods_supported?: string[];
    resource_documentation?: string;
}
export interface AuthorizationServerMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    response_types_supported: string[];
    grant_types_supported: string[];
    token_endpoint_auth_methods_supported: string[];
    code_challenge_methods_supported?: string[];
    scopes_supported?: string[];
    registration_endpoint?: string;
}
export interface ClientRegistrationRequest {
    redirect_uris: string[];
    client_name: string;
    client_uri?: string;
    logo_uri?: string;
    scope?: string;
    contacts?: string[];
    tos_uri?: string;
    policy_uri?: string;
    jwks_uri?: string;
    software_id?: string;
    software_version?: string;
}
export interface ClientRegistrationResponse extends ClientRegistrationRequest {
    client_id: string;
    client_secret?: string;
    client_id_issued_at?: number;
    client_secret_expires_at?: number;
    registration_access_token?: string;
    registration_client_uri?: string;
}
export interface OAuthError {
    error: string;
    error_description?: string;
    error_uri?: string;
    state?: string;
}
export interface TokenIntrospectionRequest {
    token: string;
    token_type_hint?: 'access_token' | 'refresh_token';
}
export interface TokenIntrospectionResponse {
    active: boolean;
    client_id?: string;
    username?: string;
    scope?: string;
    exp?: number;
    iat?: number;
    nbf?: number;
    sub?: string;
    aud?: string;
    iss?: string;
    jti?: string;
}
//# sourceMappingURL=types.d.ts.map