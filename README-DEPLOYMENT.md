# KMS MCP Deployment Guide

## Environment Variables - 100% Doppler

This project uses **Doppler for ALL environment variables**. No local `.env` files should exist.

### Local Development

```bash
# Install Doppler CLI
curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sudo sh

# Authenticate with Doppler
doppler login

# Set project context (in project directory)
doppler setup --project ry-local --config dev

# Run application with Doppler
doppler run -- node dist/index.js

# Docker with Doppler
doppler run -- docker run --rm -p 3001:3001 \
  -e MEM0_API_KEY="$MEM0_API_KEY" \
  -e MONGODB_ATLAS_URI="$MONGODB_ATLAS_URI" \
  -e NEO4J_AURA_URI="$NEO4J_AURA_URI" \
  -e NEO4J_AURA_USERNAME="$NEO4J_AURA_USERNAME" \
  -e NEO4J_AURA_PASSWORD="$NEO4J_AURA_PASSWORD" \
  -e NODE_ENV="$NODE_ENV" \
  -e TRANSPORT_MODE="$TRANSPORT_MODE" \
  -e HTTP_PORT="$HTTP_PORT" \
  -e HTTP_HOST="$HTTP_HOST" \
  -e OAUTH_ENABLED="$OAUTH_ENABLED" \
  ryaker/kms-mcp:secure
```

### Railway Deployment

```bash
# Install Railway CLI
curl -fsSL https://railway.app/install.sh | sh

# Login and initialize
railway login
railway init

# Set Doppler integration or manual environment variables
railway variables set DOPPLER_TOKEN=<your-service-token>
railway variables set DOPPLER_PROJECT=ry-local
railway variables set DOPPLER_CONFIG=dev

# Deploy
railway up
```

### Required Environment Variables (via Doppler)

- `MEM0_API_KEY`
- `MEM0_ORG_ID`
- `MONGODB_ATLAS_URI`
- `MONGODB_DATABASE`
- `NEO4J_AURA_URI`
- `NEO4J_AURA_USERNAME`
- `NEO4J_AURA_PASSWORD`
- `NODE_ENV`
- `TRANSPORT_MODE`
- `HTTP_PORT`
- `HTTP_HOST`
- `OAUTH_ENABLED`
- `OAUTH_CLIENT_ID`
- `OAUTH_CLIENT_SECRET`
- `OAUTH_ISSUER`
- `OAUTH_AUDIENCE`
- `OAUTH_JWKS_URI`
- `OAUTH_AUTHORIZATION_ENDPOINT`
- `OAUTH_TOKEN_ENDPOINT`
- `OAUTH_TOKEN_INTROSPECTION_ENDPOINT`

## Security Notes

- ✅ **NO** `.env` files in repository
- ✅ **NO** hardcoded credentials anywhere
- ✅ **ALL** secrets managed through Doppler
- ✅ Comprehensive `.gitignore` prevents credential exposure