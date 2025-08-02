# 🚀 Complete Oracle Cloud Always Free Setup Guide for KMS MCP

## 📝 Step 1: Sign Up for Oracle Cloud Always Free

### What You Need:
- Valid email address
- Phone number for verification  
- Credit/debit card (for identity verification only - **no charges**)

### Signup Process:
1. **Visit**: https://www.oracle.com/cloud/free/
2. **Click**: "Start for free"
3. **Fill form**: Basic info (name, email, country)
4. **Verify email**: Click link in verification email
5. **Add payment**: Credit card for identity verification only
6. **Verify phone**: Enter SMS code
7. **Done**: Access Oracle Cloud Console

⚠️ **Important**: Card is NEVER charged unless you manually upgrade to paid

## 🖥️ Step 2: Create ARM Ampere A1 Instance

### Instance Creation:
1. **Navigate**: Compute → Instances → "Create Instance"
2. **Name**: `kms-mcp-server`
3. **Shape**: Click "Change shape"
   - Select "Ampere" 
   - Choose `VM.Standard.A1.Flex`
   - **CPU**: 4 OCPUs (max free tier)
   - **Memory**: 24 GB (max free tier)
4. **Image**: Ubuntu 22.04 LTS (ARM64)
5. **Networking**: 
   - Create new VCN with internet connectivity
   - ✅ Assign public IP
6. **SSH Keys**: Generate new keypair & download private key
7. **Click**: "Create"

## 🐳 Step 3: Install Docker on ARM64 Ubuntu

### SSH to Instance:
```bash
ssh -i your-private-key.key ubuntu@YOUR_PUBLIC_IP
```

### Install Docker:
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install prerequisites
sudo apt install apt-transport-https ca-certificates curl software-properties-common -y

# Add Docker GPG key
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo chmod a+r /etc/apt/keyrings/docker.gpg
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-compose-plugin -y

# Add user to docker group
sudo usermod -aG docker ubuntu

# Reboot
sudo reboot
```

## 🔥 Step 4: Configure Firewall & Security

### Oracle Cloud Security Lists:
1. **Go to**: Networking → Virtual Cloud Networks → Your VCN
2. **Click**: Security Lists → Default Security List
3. **Add Ingress Rules**:

```
Source: 0.0.0.0/0, Protocol: TCP, Port: 3000 (KMS MCP)
Source: 0.0.0.0/0, Protocol: TCP, Port: 8080 (Alternative port)
Source: 0.0.0.0/0, Protocol: TCP, Port: 27017 (MongoDB)
Source: 0.0.0.0/0, Protocol: TCP, Port: 7474 (Neo4j HTTP)
Source: 0.0.0.0/0, Protocol: TCP, Port: 7687 (Neo4j Bolt)
```

### Instance Firewall:
```bash
# Allow Docker ports
sudo ufw allow 3000
sudo ufw allow 8080
sudo ufw allow 27017
sudo ufw allow 7474
sudo ufw allow 7687
sudo ufw enable
```

## 🚀 Step 5: Deploy KMS MCP

### Clone & Deploy:
```bash
# Clone your KMS MCP repo
git clone https://github.com/yourusername/KMSmcp.git
cd KMSmcp

# Use cloud docker-compose
docker compose -f docker-compose.cloud.yml up -d

# Check status
docker compose ps
```

### Access Your KMS MCP:
- **KMS MCP**: `http://YOUR_PUBLIC_IP:3000`
- **MongoDB**: `YOUR_PUBLIC_IP:27017`
- **Neo4j**: `http://YOUR_PUBLIC_IP:7474`

## 💰 What You Get for FREE:

- **4 ARM CPUs** + **24GB RAM** (equivalent to $200+/month elsewhere)
- **200GB storage**
- **10TB monthly transfer**
- **Permanent** (no time limits)
- **Production ready**

## 🎯 Next Steps:

1. Point your domain to the public IP
2. Set up SSL with Let's Encrypt
3. Configure backup strategies
4. Monitor resource usage in Oracle Console

Your KMS MCP will be running on enterprise-grade infrastructure at **$0/month**! 🎉

## 📚 Additional Resources

### Troubleshooting
- **Instance won't start**: Check availability in your region (some regions have capacity limits)
- **SSH connection refused**: Verify security list rules allow port 22
- **Docker permission denied**: Ensure user is in docker group and you've rebooted

### Monitoring
- **Oracle Console**: Monitor CPU, memory, and network usage
- **Resource limits**: Stay within Always Free limits to avoid charges
- **Backup strategy**: Use Oracle Object Storage (also free tier available)

### Security Best Practices
- **SSH keys only**: Disable password authentication
- **Firewall rules**: Only open necessary ports
- **Regular updates**: Keep system and Docker updated
- **SSL certificates**: Use Let's Encrypt for HTTPS

### Cost Management
- **Always Free resources**: Monitor usage in Oracle Console
- **Billing alerts**: Set up notifications for any charges
- **Resource optimization**: Use ARM64 Docker images for better performance

---

*Created: $(date)*
*For: KMS MCP Deployment on Oracle Cloud Always Free*