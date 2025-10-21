# Auth0 Client Cleanup Scripts

## Overview

Auth0 has limits on the number of applications (clients) per tenant. When using OAuth dynamic client registration with the MCP server, each connection creates a new client in Auth0. Over time, this can cause you to hit the limit.

This cleanup script helps you automatically delete old dynamically registered OAuth clients.

## Prerequisites

### 1. Create Auth0 Management API Application

You need a Machine-to-Machine (M2M) application in Auth0 with Management API access:

1. Go to your Auth0 Dashboard: https://manage.auth0.com
2. Navigate to **Applications** → **Applications**
3. Click **Create Application**
4. Choose **Machine to Machine Applications**
5. Name it: "Management API - Client Cleanup"
6. Select the **Auth0 Management API** as the API
7. Grant the following permissions:
   - `read:clients`
   - `delete:clients`
8. Click **Authorize**

### 2. Add Credentials to Doppler

Add these three environment variables to your Doppler `ry-local/dev` config:

```bash
AUTH0_DOMAIN=dev-xyz.us.auth0.com          # Your Auth0 domain
AUTH0_CLIENT_ID=abc123...                  # M2M application client ID
AUTH0_CLIENT_SECRET=xyz789...              # M2M application client secret
```

Or if you prefer to use existing OAuth variables:
- `OAUTH_ISSUER` will be used for domain (without https://)
- `OAUTH_CLIENT_ID` will be used for client ID
- `OAUTH_CLIENT_SECRET` will be used for client secret

## Usage

### Dry Run (Recommended First)

Always do a dry run first to see what would be deleted:

```bash
# See what would be deleted (7+ days old)
doppler run -- npm run auth0:cleanup:dry-run

# See what would be deleted (30+ days old)
doppler run -- npm run auth0:cleanup:dry-run -- --days=30
```

### Actually Delete Clients

Once you're satisfied with the dry run results:

```bash
# Delete clients older than 7 days
doppler run -- npm run auth0:cleanup

# Delete clients older than 30 days
doppler run -- npm run auth0:cleanup -- --days=30
```

### Direct Script Execution

You can also run the script directly:

```bash
# Dry run
doppler run -- tsx scripts/cleanup-auth0-clients.ts --dry-run

# Delete mode with custom age threshold
doppler run -- tsx scripts/cleanup-auth0-clients.ts --days=14
```

## How It Works

The script:

1. **Authenticates** with Auth0 Management API using client credentials
2. **Fetches** all clients from your Auth0 tenant
3. **Filters** for dynamically registered clients by looking for:
   - Names containing "dynamic" or "mcp"
   - Metadata flag `dynamically_registered: true`
   - Grant types typical of OAuth flows (`authorization_code` + `refresh_token`)
4. **Checks age** against the threshold (default: 7 days)
5. **Deletes** matching clients (or shows them in dry-run mode)

## Client Detection Logic

A client is considered "dynamically registered" if it matches ANY of these criteria:

- Client name contains "dynamic" (case-insensitive)
- Client name contains "mcp" (case-insensitive)
- Client metadata has `dynamically_registered: "true"`
- Has both `authorization_code` and `refresh_token` grant types

**Note**: Adjust the detection logic in `findOldDynamicClients()` if your clients have different patterns.

## Safety Features

- **Dry run by default** via npm script
- **Age threshold** prevents deleting recent clients
- **Specific filtering** only targets dynamic clients
- **Detailed output** shows what will be deleted before deleting
- **Error handling** continues if individual deletions fail

## Automating Cleanup

### Option 1: GitHub Actions (Recommended)

Create `.github/workflows/cleanup-auth0.yml`:

```yaml
name: Cleanup Auth0 Clients

on:
  schedule:
    # Run every Sunday at 2 AM UTC
    - cron: '0 2 * * 0'
  workflow_dispatch: # Allow manual trigger

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm install

      - name: Install Doppler CLI
        run: |
          curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sudo sh

      - name: Run cleanup
        env:
          DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}
        run: |
          doppler run --token="$DOPPLER_TOKEN" --project=ry-local --config=dev -- npm run auth0:cleanup -- --days=30
```

Add `DOPPLER_TOKEN` as a GitHub repository secret.

### Option 2: Railway Scheduled Job

Create a new Railway service:

```toml
# railway-cleanup.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "doppler run -- npm run auth0:cleanup -- --days=30"
cronSchedule = "0 2 * * 0"  # Every Sunday at 2 AM
```

### Option 3: Local Cron Job

Add to your crontab:

```bash
# Edit crontab
crontab -e

# Add line (runs every Sunday at 2 AM)
0 2 * * 0 cd /Volumes/Dev/localDev/KMSmcp && /usr/local/bin/doppler run -- npm run auth0:cleanup -- --days=30 >> /tmp/auth0-cleanup.log 2>&1
```

## Troubleshooting

### "Missing required environment variables"

Make sure you're running with Doppler:
```bash
doppler run -- npm run auth0:cleanup:dry-run
```

Or set environment variables manually:
```bash
export AUTH0_DOMAIN=your-domain.us.auth0.com
export AUTH0_CLIENT_ID=your-client-id
export AUTH0_CLIENT_SECRET=your-client-secret
npm run auth0:cleanup:dry-run
```

### "Failed to get Auth0 access token"

- Verify your Auth0 credentials in Doppler
- Check the M2M application has `read:clients` and `delete:clients` permissions
- Ensure the client secret hasn't been rotated

### "No old dynamic clients to clean up"

This is good! It means you don't have old clients accumulating. You can:
- Lower the `--days` threshold to see more clients
- Check the detection logic matches your client naming patterns

### Clients not being detected

The script looks for specific patterns. If your dynamically registered clients don't match these patterns, you'll need to update the `findOldDynamicClients()` method:

```typescript
// Example: Add custom detection logic
const isDynamic =
  client.name?.toLowerCase().includes('your-pattern') ||
  client.client_metadata?.your_custom_flag === 'true' ||
  // ... existing logic
```

## Best Practices

1. **Always dry-run first** - Verify what will be deleted
2. **Use appropriate thresholds** - 7 days for development, 30+ days for production
3. **Automate it** - Set up GitHub Actions or cron job to run weekly
4. **Monitor limits** - Check Auth0 dashboard regularly for client count
5. **Keep some buffer** - Don't wait until you hit the limit to clean up

## Auth0 Client Limits

Default limits by plan (as of 2024):
- **Free**: 1 M2M application
- **Developer**: 1 M2M application
- **Developer Pro**: Unlimited M2M applications
- **Enterprise**: Custom limits

Dynamic client registration adds to your total client count. Regular cleanup helps stay under limits.
