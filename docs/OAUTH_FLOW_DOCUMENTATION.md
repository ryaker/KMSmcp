# OAuth 2.1 + PKCE Flow Documentation for KMS MCP Server

## Overview

The KMS MCP Server implements OAuth 2.1 with PKCE (Proof Key for Code Exchange) for secure authentication. This document details the complete OAuth flow, payload formats, and troubleshooting.

## Authentication Flow

### 1. OAuth Discovery Phase

Claude discovers OAuth endpoints through well-known metadata URLs:

```bash
GET /.well-known/oauth-authorization-server
GET /.well-known/oauth-protected-resource  
```

**Response Format:**
```json
{
  "issuer": "https://dev-0pwckht3ptjwf0kg.us.auth0.com/",
  "authorization_endpoint": "https://your-server.ngrok-free.app/authorize",
  "token_endpoint": "https://your-server.ngrok-free.app/oauth/token", 
  "registration_endpoint": "https://your-server.ngrok-free.app/register",
  "jwks_uri": "https://dev-0pwckht3ptjwf0kg.us.auth0.com/.well-known/jwks.json",
  "scopes_supported": ["mcp:read", "mcp:write", "mcp:admin"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"]
}
```

### 2. Dynamic Client Registration

Claude registers itself using OAuth 2.0 Dynamic Client Registration (RFC 7591):

```bash
POST /register
Content-Type: application/json

{
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

**Server Processing:**
1. Creates Auth0 client using Management API
2. Maps Claude's client ID to Auth0 client ID
3. Returns client registration response

**Response:**
```json
{
  "client_id": "mTj3H3Ij7znpf4t6l5ziSVHWueEfysAa",
  "client_name": "Claude", 
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "mcp:read mcp:write mcp:admin",
  "client_id_issued_at": 1643723400,
  "token_endpoint_auth_method": "none"
}
```

### 3. Authorization Request

Claude initiates authorization with PKCE:

```bash
GET /authorize?response_type=code&client_id=mTj3H3Ij7znpf4t6l5ziSVHWueEfysAa&redirect_uri=https://claude.ai/api/mcp/auth_callback&code_challenge=_V5snYQncSbsfyj8ya8bWXixa3miw-kW-qeeU3Hp7c8&code_challenge_method=S256&state=9-kPz3200zvbib_sI0xURXmWMYWuL7WdTdt4XtcsNoU&scope=mcp:read%20mcp:write%20mcp:admin
```

**Server Processing:**
1. Looks up existing client mapping or creates new Auth0 client
2. Redirects to Auth0 with mapped client ID
3. User authenticates via Auth0

### 4. Token Exchange

After successful authorization, Claude exchanges code for tokens:

```bash
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&client_id=mTj3H3Ij7znpf4t6l5ziSVHWueEfysAa&code=AUTH_CODE&redirect_uri=https://claude.ai/api/mcp/auth_callback&code_verifier=CODE_VERIFIER
```

**Server Processing:**
1. Maps Claude's client ID to Auth0 client ID
2. Proxies token request to Auth0
3. Returns tokens to Claude

**Response:**
```json
{
  "access_token": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwiaXNzIjoi...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "mcp:read mcp:write mcp:admin"
}
```

## Auth0 Management API Integration

### Client Creation Payload

**Correct Auth0 Management API format:**
```json
{
  "name": "Claude MCP Client",
  "app_type": "spa",
  "callbacks": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code"],
  "token_endpoint_auth_method": "none"
}
```

**Common Payload Errors (DO NOT USE):**
```json
{
  "client_name": "...",        // ❌ Use "name" instead
  "application_type": "...",   // ❌ Use "app_type" instead  
  "redirect_uris": ["..."],    // ❌ Use "callbacks" instead
  "response_types": ["..."]    // ❌ Not needed for Management API
}
```

### Management API Authentication

```javascript
// Get management API token
const tokenResponse = await fetch(`${AUTH0_ISSUER}oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_id: MANAGEMENT_CLIENT_ID,
    client_secret: MANAGEMENT_CLIENT_SECRET, 
    audience: `${AUTH0_ISSUER}api/v2/`,
    grant_type: 'client_credentials'
  })
})

// Create client
const createResponse = await fetch(`${AUTH0_ISSUER}api/v2/clients`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${managementToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(clientData)
})
```

## Client ID Mapping System

The server maintains a mapping between Claude's generated client IDs and Auth0 client IDs:

```javascript
// Simple in-memory mapping (production should use Redis/database)
const clientMappings = {
  "OoQIkm5QHDMPR5oA2kUvjb4mxLb6bL10": "8C414OZZ0IeNifDKUGdmjKHwYtCXG5Vu"
}

// Lookup mapping
async function findMappedClient(claudeClientId) {
  return clientMappings[claudeClientId] || null
}

// Store mapping  
async function storeClientMapping(claudeClientId, auth0ClientId) {
  clientMappings[claudeClientId] = auth0ClientId
}
```

## Environment Configuration

```bash
# OAuth 2.1 Configuration
OAUTH_ENABLED=true
OAUTH_ISSUER=https://dev-0pwckht3ptjwf0kg.us.auth0.com/
OAUTH_AUDIENCE=https://mcp.yaker.org/api
OAUTH_JWKS_URI=https://dev-0pwckht3ptjwf0kg.us.auth0.com/.well-known/jwks.json

# Management API Credentials
OAUTH_CLIENT_ID=TJtbR6GDD3V45f15tTNf7km0JbM89QTS
OAUTH_CLIENT_SECRET=WMZLuDKtv26roJpSO-tbrMnToFJ26GBQvgDbw65K-gHSxzeSGzokO5E5RUspeYwE

# Auth0 Endpoints
OAUTH_AUTHORIZATION_ENDPOINT=https://dev-0pwckht3ptjwf0kg.us.auth0.com/authorize
OAUTH_TOKEN_ENDPOINT=https://dev-0pwckht3ptjwf0kg.us.auth0.com/oauth/token
```

## Troubleshooting Common Issues

### "Unknown client" Error

**Symptom:** Auth0 logs show "Unknown client: OoQIkm5QHDMPR5oA2kUvjb4mxLb6bL10"

**Cause:** OAuth metadata points directly to Auth0 instead of proxy endpoints

**Fix:** Ensure metadata returns proxy endpoints:
```json
{
  "authorization_endpoint": "https://your-server.app/authorize",  // ✅ Proxy
  "token_endpoint": "https://your-server.app/oauth/token"        // ✅ Proxy
}
```

**Not:**
```json
{
  "authorization_endpoint": "https://auth0-domain.com/authorize", // ❌ Direct
  "token_endpoint": "https://auth0-domain.com/oauth/token"       // ❌ Direct  
}
```

### 400 Bad Request on Client Creation

**Symptom:** "Additional properties not allowed: client_name, redirect_uris"

**Cause:** Using OAuth DCR property names instead of Auth0 Management API names

**Fix:** Use correct Auth0 Management API properties (see payload format above)

### Missing Authorization Header

**Symptom:** "Missing Authorization header" on MCP requests

**Cause:** OAuth flow incomplete or token not being sent

**Fix:** Verify complete OAuth flow and token storage

## Successful Authentication Logs

When working correctly, you should see:

```
🔐 Dynamic Client Registration request received
✅ Got management API token  
✅ Auth0 client created: mTj3H3Ij7znpf4t6l5ziSVHWueEfysAa
🔐 OAuth authorize request for client: mTj3H3Ij7znpf4t6l5ziSVHWueEfysAa
✅ Auth0 client created: hxjh9EWRg87C5lkSkqumUQJgybjuLhnb

Authenticated user: {
  isAuthenticated: true,
  user: { id: 'unknown', email: undefined, name: undefined, roles: [] },
  token: {
    type: 'Bearer',
    value: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwiaXNzIjoi...',
    scope: 'mcp:read mcp:write mcp:admin',
    expiresAt: undefined
  }
}
```

## Security Considerations

1. **PKCE Required:** All authorization requests must include code_challenge
2. **Public Client:** token_endpoint_auth_method is "none" (no client secret)
3. **Scoped Access:** Tokens limited to mcp:read, mcp:write, mcp:admin scopes
4. **Token Validation:** All MCP requests validated against Auth0 JWKS
5. **Client Mapping:** Secure storage of client ID mappings in production
