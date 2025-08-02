#!/bin/bash
# Unified KMS MCP Server - Docker Deployment Script

set -e

echo "🚀 Deploying Unified KMS MCP Server with Docker"
echo "=============================================="

# Check if .env.docker exists
if [ ! -f .env.docker ]; then
    echo "❌ .env.docker file not found!"
    echo "Please copy .env.docker.example to .env.docker and configure your settings"
    exit 1
fi

# Check required environment variables
source .env.docker

if [ -z "$MEM0_API_KEY" ]; then
    echo "❌ MEM0_API_KEY is required in .env.docker"
    exit 1
fi

# Create necessary directories
mkdir -p ssl scripts logs

# Build and start services
echo "📦 Building Docker images..."
docker-compose build

echo "🔄 Starting services..."
docker-compose up -d

# Wait for services to be healthy
echo "⏳ Waiting for services to start..."
sleep 30

# Check service health
echo "🏥 Checking service health..."
docker-compose ps

# Test the health endpoint
echo "🧪 Testing MCP server health..."
if curl -f http://localhost:3001/health > /dev/null 2>&1; then
    echo "✅ MCP Server is healthy!"
else
    echo "❌ MCP Server health check failed"
    echo "📋 Recent logs:"
    docker-compose logs --tail=20 unified-kms
    exit 1
fi

# Display connection information
echo ""
echo "🎉 Deployment Complete!"
echo "======================"
echo "📡 MCP Endpoint: http://localhost:3001/mcp"
echo "🏥 Health Check: http://localhost:3001/health"
echo "📺 SSE Events: http://localhost:3001/mcp/events"
echo "🔐 OAuth Discovery: http://localhost:3001/.well-known/oauth-protected-resource"
echo ""
echo "Database UIs:"
echo "🍃 MongoDB: mongodb://localhost:27017"
echo "🔗 Neo4j Browser: http://localhost:7474"
echo "🔴 Redis: redis://localhost:6379"
echo ""
echo "📋 To view logs: docker-compose logs -f unified-kms"
echo "🛑 To stop: docker-compose down"

# Test OAuth if enabled
if [ "$OAUTH_ENABLED" = "true" ]; then
    echo ""
    echo "🔐 OAuth 2.1 is ENABLED"
    echo "📋 Configure your authorization server with:"
    echo "   Resource: $OAUTH_AUDIENCE"
    echo "   Issuer: $OAUTH_ISSUER"
fi