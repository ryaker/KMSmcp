# 🖥️ M1 Mini Build Server & Remote Development Setup

Transform your M1 Mini into a powerful React Native build server and remote development machine, fully manageable by Claude Code.

## 📋 Setup Order

1. **On M1 Mini:**
   ```bash
   # Step 1: Clean up storage
   bash 01-storage-cleanup.sh

   # Step 2: Enable remote access
   bash 02-enable-remote-access.sh

   # Step 4: Setup React Native build environment
   bash 04-react-native-build-server.sh

   # Step 5: Install sysadmin toolkit
   bash 05-claude-sysadmin-toolkit.sh
   ```

2. **On MacBook Air:**
   ```bash
   # Step 3: Configure connection to M1 Mini
   bash 03-macbook-air-setup.sh
   ```

## 🚀 Quick Start Commands

### From MacBook Air

```bash
# SSH to M1 Mini
ssh m1-mini

# Mount M1 Mini filesystem
mount-mini.sh

# Open VS Code on M1 Mini
code --remote ssh-remote+m1-mini /path/to/project

# Claude sysadmin commands
claude-mini-admin.sh storage     # Check storage
claude-mini-admin.sh cleanup     # Run cleanup
claude-mini-admin.sh status      # System status

# Trigger remote builds
ssh m1-mini 'rn-build-server.sh build-ios ~/project'
ssh m1-mini 'rn-build-server.sh build-android ~/project'
```

## 🤖 Claude Code Sysadmin Capabilities

Claude can now:
- **Analyze storage** and find what's filling your 256GB
- **Clean up space** intelligently and safely
- **Monitor system health** in real-time
- **Manage React Native builds** remotely
- **Auto-fix common issues**

### Storage Management
```bash
# Deep storage analysis
claude-m1-sysadmin.sh analyze-storage

# Smart cleanup (safe operations only)
claude-m1-sysadmin.sh smart-cleanup

# Find duplicate files
claude-m1-sysadmin.sh find-duplicates
```

### System Health
```bash
# Complete health check
claude-m1-sysadmin.sh health-check

# Auto-fix detected issues
claude-m1-sysadmin.sh auto-fix

# Real-time monitoring
claude-m1-sysadmin.sh monitor
```

## 🏗️ React Native Build Server

### Features
- Metro bundler auto-start
- iOS and Android build support
- Automatic cache management
- Remote build triggers
- Build artifact management

### Usage
```bash
# On M1 Mini
rn-build-server.sh start    # Start services
rn-build-server.sh status   # Check status
rn-build-server.sh clean    # Clean caches

# From MacBook Air
ssh m1-mini 'cd ~/project && npm run ios'
ssh m1-mini 'cd ~/project && npm run android'
```

## 💾 Mounted Filesystem Access

After running `mount-mini.sh`:
- Access M1 Mini files at `~/RemoteMounts/M1Mini/`
- Browse in Finder like a local drive
- Edit files with any local editor
- Claude Code can access and analyze files

## 🔧 Advanced Features

### Workspace Sync
```bash
# Sync project from MacBook to M1 Mini
rsync -avz ~/project/ m1-mini:~/project/

# Watch for changes and auto-sync
fswatch -o ~/project | xargs -n1 -I{} rsync -avz ~/project/ m1-mini:~/project/
```

### Remote VS Code Development
```bash
# Open project on M1 Mini
code --remote ssh-remote+m1-mini ~/project

# Install extensions on remote
code --remote ssh-remote+m1-mini --install-extension <extension-id>
```

### Docker on M1 Mini (Optional)
```bash
# Install Docker
ssh m1-mini 'brew install --cask docker'

# Use for containerized builds
ssh m1-mini 'docker run -v ~/project:/app node:16 npm run build'
```

## 🛡️ Security Notes

- SSH keys are used for passwordless authentication
- Firewall configured to allow only necessary services
- File sharing uses encrypted SMB/AFP protocols
- Screen sharing uses built-in macOS VNC

## 📊 Storage Optimization Tips

Common space hogs on M1 Mini:
- `~/Library/Developer/Xcode/DerivedData/` (often 20-50GB)
- `~/Library/Developer/Xcode/iOS DeviceSupport/` (10-30GB)
- `~/Library/Developer/CoreSimulator/Devices/` (5-20GB)
- Old `node_modules` directories (can be massive)
- Docker images and containers
- Homebrew cache

Regular cleanup routine:
```bash
# Run weekly
claude-m1-sysadmin.sh smart-cleanup
```

## 🎯 Next Steps

1. Set up Time Machine backups on M1 Mini
2. Configure CI/CD pipelines using M1 Mini
3. Install additional development tools as needed
4. Set up monitoring dashboards
5. Configure automatic builds on git push

## 🆘 Troubleshooting

**Can't connect via SSH:**
```bash
# On M1 Mini, check SSH is enabled
sudo systemsetup -getremotelogin
```

**SSHFS mount fails:**
```bash
# Install macFUSE first
brew install --cask macfuse
# Restart Mac
# Then install sshfs
brew install gromgit/fuse/sshfs-mac
```

**Build server not starting:**
```bash
# Check logs
tail -f ~/build-logs/metro.log
tail -f ~/build-logs/buildserver.log
```

---

Your M1 Mini is now a powerful extension of your MacBook Air, with Claude Code able to manage it as a full sysadmin! 🚀