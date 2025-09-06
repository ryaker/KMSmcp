# Local Testing Guide for MCP Gateway

## Overview
Test the entire MCP gateway setup locally before deploying to Railway. This ensures OAuth, routing, and all services work correctly without risking production.

## Prerequisites
- Docker Desktop installed and running
- Node.js 18+ (for local development)
- curl and jq installed (for testing scripts)
- Optional: Auth0/Stytch account for OAuth testing

## Quick Start

### 1. Initial Setup (No OAuth)
```bash
# Copy test environment variables
cp .env.local-test .env

# Build and start all services
docker-compose -f docker-compose.local-test.yml up --build

# In another terminal, run tests
./test/test-gateway.sh
```

### 2. Test Service Routing
```bash
# Test gateway health
curl http://localhost:8080/health

# Get service directory
curl http://localhost:8080/directory | jq

# Test KMS MCP through gateway
curl -X POST http://localhost:8080/kms/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}' | jq

# Test stub services
curl http://localhost:8080/coaching/health
curl http://localhost:8080/mongodb/health
curl http://localhost:8080/neo4j/health
```

### 3. Enable OAuth Testing
```bash
# Edit .env and set:
OAUTH_ENABLED=true
OAUTH_ISSUER=https://your-tenant.auth0.com
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
OAUTH_JWKS_URI=https://your-tenant.auth0.com/.well-known/jwks.json

# Restart services
docker-compose -f docker-compose.local-test.yml down
docker-compose -f docker-compose.local-test.yml up

# Run OAuth tests
./test/test-oauth.sh
```

## Testing Scenarios

### Scenario 1: Basic Routing (OAuth Disabled)
This tests that the gateway correctly routes to different MCP services:

1. **Start services with OAuth disabled**
2. **Verify all routes work:**
   - `/` → Service directory
   - `/health` → Gateway health
   - `/kms/*` → KMS MCP
   - `/coaching/*` → Coaching MCP (stub)
   - `/mongodb/*` → MongoDB MCP (stub)
   - `/neo4j/*` → Neo4j MCP (stub)

### Scenario 2: OAuth Flow (OAuth Enabled)
This tests that authentication is properly enforced and forwarded:

1. **Enable OAuth in .env**
2. **Restart services**
3. **Test unauthenticated requests fail (401)**
4. **Get access token from Auth0/Stytch**
5. **Test authenticated requests succeed (200)**
6. **Verify token is forwarded to backend services**

### Scenario 3: Claude Desktop Integration
Test with actual Claude Desktop client:

1. **Configure Claude Desktop:**
```json
{
  "mcpServers": {
    "local-test-kms": {
      "type": "http",
      "url": "http://localhost:8080/kms/mcp"
    }
  }
}
```

2. **If OAuth enabled, add token:**
```json
{
  "mcpServers": {
    "local-test-kms": {
      "type": "http",
      "url": "http://localhost:8080/kms/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN"
      }
    }
  }
}
```

3. **Test MCP tools work through Claude**

## Monitoring During Tests

### Watch Gateway Logs
```bash
docker logs -f mcp-gateway
```

### Watch KMS MCP Logs
```bash
docker logs -f kms-mcp
```

### Check Service Health
```bash
# Check all services are healthy
docker ps

# Check specific service health
docker inspect kms-mcp | jq '.[0].State.Health'
```

## Troubleshooting

### Issue: Services not starting
```bash
# Check for port conflicts
lsof -i :8080
lsof -i :3001-3004

# Clean restart
docker-compose -f docker-compose.local-test.yml down -v
docker-compose -f docker-compose.local-test.yml up --build
```

### Issue: OAuth not working
```bash
# Verify environment variables
docker exec mcp-gateway env | grep OAUTH

# Check JWKS endpoint is accessible
curl https://your-tenant.auth0.com/.well-known/jwks.json

# Test token directly
curl -X POST http://localhost:8080/kms/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

### Issue: Network connectivity
```bash
# Test internal Docker networking
docker exec mcp-gateway ping kms-mcp
docker exec mcp-gateway curl http://kms-mcp:3001/health

# Check Docker network
docker network inspect kmsmcp_mcp-network
```

## Migration Checklist

Before deploying to Railway:

- [ ] All routing tests pass locally
- [ ] OAuth flow works with test credentials
- [ ] Claude Desktop can connect and use tools
- [ ] No errors in gateway or KMS logs
- [ ] Performance is acceptable (< 100ms overhead)
- [ ] All environment variables documented
- [ ] Rollback plan tested (direct KMS connection)

## Clean Up

```bash
# Stop all services
docker-compose -f docker-compose.local-test.yml down

# Remove volumes (clean slate)
docker-compose -f docker-compose.local-test.yml down -v

# Remove test images
docker rmi kmsmcp_mcp-gateway kmsmcp_kms-mcp
```

## Next Steps

Once local testing is successful:

1. Deploy gateway to Railway as new service
2. Test with staging domain first
3. Update production DNS only after verification
4. Keep direct KMS access as backup

Remember: The beauty of this setup is that your existing KMS continues to work independently. The gateway is just an additional layer that can be added/removed without breaking the core service.