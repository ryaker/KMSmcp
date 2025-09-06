# Redis Keep-Alive (Built into MCP Server)

## Overview

Redis keep-alive functionality is now **built directly into the KMS MCP server**. When the server runs and connects to Redis, it automatically sends periodic keep-alive pings to prevent Upstash from marking the database as inactive.

## How It Works

The keep-alive system:
1. **Automatic Activation**: Starts automatically when the MCP server connects to Redis
2. **Minimal Traffic**: Sends a small ping once every 24 hours
3. **Smart Cleanup**: Maintains only the last 5 test entries to avoid database bloat
4. **Graceful Shutdown**: Stops cleanly when the server shuts down

## Features

- **No Manual Intervention**: Runs automatically with the MCP server
- **Secure**: Uses existing Doppler/environment configuration (no hardcoded credentials)
- **Lightweight**: Minimal impact on Redis storage and performance
- **Logging**: Reports keep-alive activity in server logs

## Configuration

The keep-alive uses the same Redis configuration as the main server:
- Gets credentials from Doppler or environment variables
- Works with both local and cloud Redis instances
- Fails gracefully if Redis is unavailable

## Monitoring

Watch for these log messages:
```
🔄 Starting Redis keep-alive (interval: 1440 minutes)
🏓 Redis keep-alive ping #1 sent at 2025-08-25T15:30:00.000Z
```

## No Action Required

As long as your MCP server is running (even occasionally), your Upstash Redis database will remain active. No cron jobs, GitHub Actions, or manual scripts needed!