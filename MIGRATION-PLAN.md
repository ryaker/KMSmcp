# OAuth-Safe Migration Plan for mcp.yaker.org

## Current State
- KMS MCP is running on Railway at its own URL
- OAuth is configured (but currently disabled with OAUTH_ENABLED=false)
- Direct connections work fine

## Migration Strategy: Parallel Deployment

### Phase 1: Deploy Gateway Alongside (No Breaking Changes)
```bash
# 1. Keep existing KMS deployment running as-is
# 2. Deploy gateway as a SEPARATE Railway service
railway up --service mcp-gateway

# 3. Configure gateway environment via Doppler
OAUTH_ENABLED=false  # Match current KMS setting
KMS_MCP_URL=http://kms-mcp.railway.internal:3001  # Internal Railway networking
```

### Phase 2: Test Gateway Routes
```bash
# Test that gateway properly forwards to KMS
curl https://mcp.yaker.org/health
curl https://mcp.yaker.org/directory

# Test KMS through gateway (should work identical to direct)
curl -X POST https://mcp.yaker.org/kms/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

### Phase 3: Update DNS (Safe Cutover)
```
# Current DNS:
mcp.yaker.org → KMS MCP directly

# New DNS (after testing):
mcp.yaker.org → Gateway → Routes to KMS MCP

# Fallback DNS (keep as backup):
kms.mcp.yaker.org → KMS MCP directly
```

### Phase 4: Enable OAuth (When Ready)
When you're ready to enable OAuth:

1. **Update Doppler variables for ALL services simultaneously:**
```bash
OAUTH_ENABLED=true
OAUTH_ISSUER=https://your-auth-provider.com
OAUTH_JWKS_URI=https://your-auth-provider.com/.well-known/jwks.json
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret

# Service-specific audiences
KMS_AUDIENCE=https://mcp.yaker.org/kms
COACHING_AUDIENCE=https://mcp.yaker.org/coaching
MONGODB_AUDIENCE=https://mcp.yaker.org/mongodb
NEO4J_AUDIENCE=https://mcp.yaker.org/neo4j
```

2. **Railway will auto-deploy with new config**

3. **Test OAuth flow:**
```bash
# Get token from your auth provider
TOKEN=$(curl -X POST https://your-auth-provider.com/oauth/token \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "audience=https://mcp.yaker.org/kms" \
  -d "grant_type=client_credentials" | jq -r .access_token)

# Test authenticated request
curl -X POST https://mcp.yaker.org/kms/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

## Rollback Plan

If anything breaks:

1. **Immediate fix**: Update DNS to point directly to KMS again
2. **Gateway issues**: The KMS continues running independently
3. **OAuth issues**: Set OAUTH_ENABLED=false in Doppler

## Benefits of This Approach

1. **Zero downtime** - KMS keeps running throughout
2. **Gradual migration** - Test gateway before switching DNS
3. **OAuth preservation** - Gateway forwards all auth headers properly
4. **Easy rollback** - Can switch back to direct connection instantly
5. **Future-proof** - Easy to add new MCP services later

## Railway Service Structure

```
Railway Project: mcp-yaker-org
├── Service: mcp-gateway (NEW)
│   ├── Port: 80/443
│   ├── Domain: mcp.yaker.org
│   └── Routes to all MCPs
│
├── Service: kms-mcp (EXISTING)
│   ├── Port: 3001
│   ├── Internal: kms-mcp.railway.internal
│   └── Backup domain: kms.mcp.yaker.org
│
├── Service: coaching-mcp (FUTURE)
│   ├── Port: 3002
│   └── Internal: coaching-mcp.railway.internal
│
└── Environment: Doppler Integration
    └── All OAuth configs shared
```