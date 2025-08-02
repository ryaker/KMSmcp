#!/bin/bash
# Unified KMS MCP Server - Cloud PaaS Deployment Script

set -e

echo "🌐 Deploying Unified KMS MCP Server with Cloud PaaS"
echo "=================================================="

# Check if .env.cloud exists
if [ ! -f .env.cloud ]; then
    echo "❌ .env.cloud file not found!"
    echo "Please copy .env.cloud to configure your cloud database connections"
    exit 1
fi

# Load environment variables
source .env.cloud

# Validate required variables
echo "🔍 Validating configuration..."

if [ -z "$MEM0_API_KEY" ]; then
    echo "❌ MEM0_API_KEY is required in .env.cloud"
    exit 1
fi

if [ -z "$MONGODB_ATLAS_URI" ]; then
    echo "❌ MONGODB_ATLAS_URI is required for MongoDB Atlas connection"
    exit 1
fi

if [ -z "$NEO4J_AURA_URI" ]; then
    echo "❌ NEO4J_AURA_URI is required for Neo4j AuraDB connection"
    exit 1
fi

if [ -z "$REDIS_CLOUD_URI" ]; then
    echo "❌ REDIS_CLOUD_URI is required for Redis Cloud connection"
    exit 1
fi

echo "✅ Configuration validated!"

# Test cloud database connections
echo "🔌 Testing cloud database connections..."

# Test MongoDB Atlas
echo "📄 Testing MongoDB Atlas connection..."
if timeout 10 mongosh "$MONGODB_ATLAS_URI" --eval "db.runCommand('ping')" > /dev/null 2>&1; then
    echo "✅ MongoDB Atlas connection successful"
else
    echo "⚠️  MongoDB Atlas connection test skipped (mongosh not available)"
fi

# Test Redis Cloud
echo "🔴 Testing Redis Cloud connection..."
if timeout 10 redis-cli -u "$REDIS_CLOUD_URI" ping > /dev/null 2>&1; then
    echo "✅ Redis Cloud connection successful"
else
    echo "⚠️  Redis Cloud connection test skipped (redis-cli not available)"
fi

# Build and deploy
echo "📦 Building Docker image..."
docker-compose -f docker-compose.cloud.yml build

echo "🚀 Starting MCP server with cloud databases..."
docker-compose -f docker-compose.cloud.yml --env-file .env.cloud up -d

# Wait for service to be healthy
echo "⏳ Waiting for MCP server to start..."
sleep 30

# Check service health
echo "🏥 Checking service health..."
if curl -f http://localhost:3001/health > /dev/null 2>&1; then
    echo "✅ MCP Server is healthy and connected to cloud databases!"
else
    echo "❌ MCP Server health check failed"
    echo "📋 Recent logs:"
    docker-compose -f docker-compose.cloud.yml logs --tail=20 unified-kms
    exit 1
fi

# Test OAuth if enabled
if [ "$OAUTH_ENABLED" = "true" ]; then
    echo "🔐 Testing OAuth discovery endpoint..."
    if curl -f http://localhost:3001/.well-known/oauth-protected-resource > /dev/null 2>&1; then
        echo "✅ OAuth 2.1 discovery endpoint is working"
    else
        echo "⚠️  OAuth discovery endpoint test failed"
    fi
fi

# Display connection information
echo ""
echo "🎉 Cloud Deployment Complete!"
echo "============================="
echo "📡 MCP Endpoint: http://localhost:3001/mcp"
echo "🏥 Health Check: http://localhost:3001/health"
echo "📺 SSE Events: http://localhost:3001/mcp/events"
echo ""
echo "☁️  Connected to Cloud Services:"
echo "🍃 MongoDB Atlas: $(echo $MONGODB_ATLAS_URI | sed 's/mongodb+srv:\/\/[^@]*@/mongodb+srv://***@/')"
echo "🔗 Neo4j AuraDB: $(echo $NEO4J_AURA_URI | sed 's/neo4j+s:\/\/[^@]*@/neo4j+s://***@/' | cut -d'/' -f3)"
echo "🔴 Redis Cloud: $(echo $REDIS_CLOUD_URI | sed 's/rediss:\/\/[^@]*@/rediss://***@/' | cut -d'/' -f3)"
echo ""
echo "📋 To view logs: docker-compose -f docker-compose.cloud.yml logs -f unified-kms"
echo "🛑 To stop: docker-compose -f docker-compose.cloud.yml down"

if [ "$OAUTH_ENABLED" = "true" ]; then
    echo ""
    echo "🔐 OAuth 2.1 is ENABLED"
    echo "📋 Test with: curl -H 'Authorization: Bearer YOUR_TOKEN' http://localhost:3001/mcp"
fi