# Unified KMS MCP Server - Production Docker Image
FROM node:24-alpine AS base

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Development stage
FROM base AS development
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:24-alpine AS production

# Install Doppler CLI
RUN apk add --no-cache curl bash gnupg && \
    curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sh && \
    doppler --version

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

WORKDIR /app

# Copy built application
COPY --from=development --chown=nextjs:nodejs /app/dist ./dist
COPY --from=development --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=development --chown=nextjs:nodejs /app/package.json ./

# Create data directory for logs and cache
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

# Switch to non-root user
USER nextjs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Expose port
EXPOSE 3001

# Start with Doppler if available, otherwise direct
CMD sh -c 'if command -v doppler >/dev/null 2>&1 && [ -n "$DOPPLER_TOKEN" ]; then echo "✅ Using Doppler"; exec doppler run --project ry-local --config "${DOPPLER_CONFIG:-dev}" -- node dist/index.js; else echo "❌ No Doppler"; exec node dist/index.js; fi'
