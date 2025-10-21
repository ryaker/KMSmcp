# Railway Deployment Fix Guide

## Issue Summary

Railway is deploying **old code** without the comprehensive debugging added in commit `d457b4fd`. Additionally, the `REDIS_CLOUD_URI` in Doppler has a malformed value with URL-encoded garbage.

## Fix 1: Clean Up REDIS_CLOUD_URI in Doppler

### Steps:
1. Go to [Doppler Dashboard](https://dashboard.doppler.com)
2. Navigate to project: `ry-local` → config: `dev`
3. Find variable: `REDIS_CLOUD_URI`
4. **Current malformed value:**
   ```
   %20--tls%20-u%20redis://default:AVhtAAIncDFhNWQ0ZTNjOGI0NmY0NzQ2OGRlYmJlOWRhOGMyM2UwM3AxMjI2Mzc@primary-zebra-22637.upstash.io:6379
   ```

5. **Update to correct value** (remove the `%20--tls%20-u%20` prefix):
   ```
   redis://default:AVhtAAIncDFhNWQ0ZTNjOGI0NmY0NzQ2OGRlYmJlOWRhOGMyM2UwM3AxMjI2Mzc@primary-zebra-22637.upstash.io:6379
   ```

6. Save the change

### Verification:
Once saved, Doppler will automatically sync to Railway. The next deployment will use the correct URI.

## Fix 2: Trigger New Railway Deployment

### Option A: Force Redeploy (Recommended)
1. Go to [Railway Dashboard](https://railway.app)
2. Navigate to your KMS MCP project
3. Go to the **Deployments** tab
4. Click on the most recent deployment
5. Click **"Redeploy"** button
6. Wait for deployment to complete

### Option B: Push Empty Commit
```bash
cd /Volumes/Dev/localDev/KMSmcp
git commit --allow-empty -m "Trigger Railway redeploy with debug code"
git push origin main
```

### Option C: Use Railway CLI
```bash
# Install Railway CLI if not already installed
npm i -g @railway/cli

# Login
railway login

# Link to project (if not already linked)
railway link

# Trigger deployment
railway up
```

## Verify Fixes

### Check Doppler Sync:
1. In Railway dashboard, go to **Variables** tab
2. Verify `REDIS_CLOUD_URI` shows the clean value (starting with `redis://`)
3. No `%20--tls%20-u%20` prefix should be visible

### Check Deployment Logs:
Once Railway redeploys, the logs should show:
```
🔍 Environment Variables Debug:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Core Variables:
   PORT: 3001
   NODE_ENV: production
   TRANSPORT_MODE: http

📊 KMS System Status:
   Mem0: ✅ Configured
   Neo4j: ✅ Configured
   MongoDB: ✅ Configured
   Redis: ✅ Configured

🔑 Auth Configuration:
   OAuth Enabled: ✅
   ...
```

If you see this debug output, the latest code is deployed!

## Current Git Status

Latest commit with debugging: `d457b4fd`
Message: "Add comprehensive environment variable debugging to Railway deployment"

Verify Railway is deploying this commit or later.

## Next Steps After Fixes

1. ✅ REDIS_CLOUD_URI fixed in Doppler
2. ✅ Railway redeployed with latest code
3. ✅ Deployment logs show debug output
4. ✅ Redis connection succeeds (or shows clear error)
5. Test `unified_search` to verify mem0 data is found

## Troubleshooting

### If Redis still fails after fixing URI:
- Check Upstash dashboard - database might be paused
- Verify password hasn't been rotated
- Test connection locally: `redis-cli -u "redis://default:password@host:6379"`

### If Railway still shows old logs:
- Check deployment status - might be using cached build
- Try clearing Railway cache (Settings → Clear Cache → Redeploy)
- Verify git remote is correct: `git remote -v`

### If environment variables not syncing:
- Check Doppler integration in Railway settings
- Verify Doppler token hasn't expired
- Manually verify each critical variable in Railway dashboard
