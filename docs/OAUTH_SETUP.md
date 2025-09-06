# OAuth Setup for Remote MCP Servers

## Overview

Remote MCP servers MUST implement OAuth 2.1 for authentication. This document explains how to properly configure OAuth for your MCP server and connect Claude clients.

## Understanding MCP OAuth

### Key Concepts

1. **MCP Server = Resource Server**: Your MCP server is an OAuth Resource Server, not an Authorization Server
2. **Auth0 = Authorization Server**: Auth0 handles authentication and issues tokens
3. **Claude Clients = OAuth Clients**: Claude Code and other MCP clients obtain tokens from Auth0

### Token Types

MCP servers must handle two token types:

1. **JWT Tokens**: Self-contained tokens with claims
   - Can be validated locally using JWKS
   - Faster validation
   - Contains user information

2. **Opaque Access Tokens**: Reference tokens
   - Must be validated via introspection (userinfo endpoint)
   - More secure (can be revoked instantly)
   - Requires network call to validate

## Auth0 Configuration

### 1. Create an API (Resource Server)

In Auth0 Dashboard:
1. Go to **Applications > APIs**
2. Click **Create API**
3. Configure:
   - Name: `MCP Server`
   - Identifier: `https://mcp.yaker.org` (your MCP URL)
   - Signing Algorithm: `RS256`

### 2. Create an Application (Client)

1. Go to **Applications > Applications**
2. Click **Create Application**
3. Choose:
   - Name: `Claude MCP Client`
   - Type: `Single Page Application` or `Native`
4. Configure:
   - Allowed Callback URLs: `http://localhost:*, https://claude.ai/callback`
   - Allowed Web Origins: `https://claude.ai`
   - Allowed CORS Origins: `https://claude.ai`

### 3. Configure Scopes

In your API settings, add scopes:
- `mcp:read` - Read access to MCP tools
- `mcp:write` - Execute MCP tools
- `mcp:admin` - Administrative access

## MCP Server Configuration

### Environment Variables

```bash
# Auth0 Configuration
OAUTH_ENABLED=true
OAUTH_ISSUER=https://dev-0pwckht3ptjwf0kg.us.auth0.com/
OAUTH_AUDIENCE=https://mcp.yaker.org
OAUTH_JWKS_URI=https://dev-0pwckht3ptjwf0kg.us.auth0.com/.well-known/jwks.json
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
```

### Discovery Endpoints

Your MCP server exposes OAuth metadata at:
- `/.well-known/oauth-protected-resource` - Resource server metadata
- `/.well-known/oauth-authorization-server` - Authorization server info

## Client Authentication Flow

### 1. Client Discovery

Claude clients discover OAuth requirements:
```http
GET https://mcp.yaker.org/.well-known/oauth-protected-resource
```

Response:
```json
{
  "resource": "https://mcp.yaker.org",
  "authorization_servers": ["https://dev-0pwckht3ptjwf0kg.us.auth0.com/"],
  "scopes_supported": ["mcp:read", "mcp:write", "mcp:admin"],
  "bearer_methods_supported": ["header"]
}
```

### 2. Token Acquisition

Clients obtain tokens from Auth0 using:
- **Authorization Code Flow** (with PKCE) for user-based access
- **Client Credentials Flow** for service-to-service

### 3. API Requests

Include token in every request:
```http
POST https://mcp.yaker.org/mcp
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "method": "tools/list",
  "jsonrpc": "2.0",
  "id": 1
}
```

## Troubleshooting

### "jwt malformed" Error

This usually means the client is sending an opaque token, not a JWT. The server will:
1. Detect it's not a JWT
2. Fall back to introspection via Auth0's userinfo endpoint
3. Validate the token and extract user info

### 401 Unauthorized Errors

Check:
1. Token is included in `Authorization: Bearer <token>` header
2. Token hasn't expired
3. Token was issued for the correct audience
4. Auth0 application is properly configured

### Token Validation Flow

```
Client Request with Token
         ↓
Is it a JWT? (3 parts, valid header)
    ↓           ↓
   Yes          No (Opaque Token)
    ↓           ↓
Validate       Call Auth0
via JWKS      Userinfo Endpoint
    ↓           ↓
 Success     Success/Fail
    ↓           ↓
  Cache     Cache/Reject
 Result
```

## Security Best Practices

1. **Always use HTTPS** in production
2. **Implement rate limiting** to prevent abuse
3. **Cache validated tokens** to reduce Auth0 API calls
4. **Log authentication attempts** for security monitoring
5. **Use short token expiration** (15-30 minutes)
6. **Implement PKCE** for all OAuth flows

## Testing

### With curl

```bash
# Get a token from Auth0
TOKEN=$(curl -X POST https://dev-0pwckht3ptjwf0kg.us.auth0.com/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "audience": "https://mcp.yaker.org",
    "grant_type": "client_credentials"
  }' | jq -r .access_token)

# Call MCP endpoint
curl -X POST https://mcp.yaker.org/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"method": "tools/list", "jsonrpc": "2.0", "id": 1}'
```

### With Claude Code

Configure in MCP settings:
```json
{
  "mcpServers": {
    "kms": {
      "url": "https://mcp.yaker.org/mcp",
      "auth": {
        "type": "oauth2",
        "authorization_url": "https://dev-0pwckht3ptjwf0kg.us.auth0.com/authorize",
        "token_url": "https://dev-0pwckht3ptjwf0kg.us.auth0.com/oauth/token",
        "client_id": "YOUR_CLIENT_ID",
        "scope": "mcp:read mcp:write"
      }
    }
  }
}
```

## References

- [MCP OAuth Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
- [OAuth 2.1 Specification](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-10)
- [Auth0 Documentation](https://auth0.com/docs)
- [MCP Authorization Blog Post](https://workos.com/blog/mcp-authorization-in-5-easy-oauth-specs)