# 🐳 Docker Desktop Deployment Guide

## Quick Start with Docker Desktop

### 1. Prerequisites
- Docker Desktop installed and running
- Your `MEM0_API_KEY` from Mem0.ai

### 2. Configure Environment
```bash
# Copy the Docker environment template
cp .env.docker .env.docker.local

# Edit with your API keys
nano .env.docker.local
```

### 3. Deploy with Docker Desktop
```bash
# Start the complete stack
docker-compose --env-file .env.docker.local up -d

# Or use the deployment script
./docker-deploy.sh
```

### 4. Access Your MCP Server
- **MCP API**: http://localhost:3001/mcp
- **Health Check**: http://localhost:3001/health  
- **Neo4j Browser**: http://localhost:7474
- **MongoDB**: mongodb://localhost:27017

## 🔐 OAuth Configuration

Your server supports **full OAuth 2.1** with:

```bash
# Enable OAuth in .env.docker.local
OAUTH_ENABLED=true
OAUTH_ISSUER=https://your-auth-server.com
OAUTH_AUDIENCE=https://your-mcp-server.com
OAUTH_JWKS_URI=https://your-auth-server.com/.well-known/jwks.json
```

## 📊 Docker Desktop Management

### View Services
Open Docker Desktop → Containers → `kmsmcp` stack

### Monitor Logs
```bash
docker-compose logs -f unified-kms
```

### Scale Services
```bash
# Scale the MCP server
docker-compose up -d --scale unified-kms=3
```

### Stop Everything
```bash
docker-compose down
```

## 🚀 Production Ready
- Health checks configured
- Non-root user security
- Nginx reverse proxy included
- SSL/TLS ready
- Rate limiting enabled