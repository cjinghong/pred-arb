# PRED-ARB VPS Deployment Plan

Deployment guide for running the prediction market arbitrage bot on a VPS. The app runs as a single Node.js process (bot + API + dashboard) and uses PM2 for process management.

---

## 1. VPS Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 512 MB | 1 GB |
| Storage | 5 GB | 10 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 / 24.04 |

**Software:**
- Node.js 18+ (20 LTS recommended)
- Git
- (Optional) Nginx for reverse proxy + SSL

---

## 2. Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │              VPS                     │
                    │  ┌─────────────────────────────────┐ │
                    │  │  Nginx (optional)                │ │
                    │  │  - SSL termination              │ │
                    │  │  - Proxy to :3848               │ │
                    │  └──────────────┬──────────────────┘ │
                    │                 │                   │
                    │  ┌──────────────▼──────────────────┐ │
                    │  │  PM2                            │ │
                    │  │  └─ pred-arb (Node.js)          │ │
                    │  │     - Bot orchestrator          │ │
                    │  │     - API server (Express)      │ │
                    │  │     - Dashboard (static)         │ │
                    │  │     - WebSocket                 │ │
                    │  └──────────────┬──────────────────┘ │
                    │                 │                   │
                    │  ┌──────────────▼──────────────────┐ │
                    │  │  SQLite (./data/pred-arb.db)     │ │
                    │  └─────────────────────────────────┘ │
                    └─────────────────────────────────────┘
```

---

## 3. Deployment Steps

### 3.1 Initial VPS Setup

```bash
# SSH into your VPS
ssh user@your-vps-ip

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # v20.x.x
npm -v
```

### 3.2 Create App User (Recommended)

```bash
# Create dedicated user for the app
sudo useradd -m -s /bin/bash predarb
sudo su - predarb
```

### 3.3 Clone & Build

```bash
# Clone repo (adjust URL for your repo)
git clone https://github.com/YOUR_USERNAME/pred-arb.git
cd pred-arb

# Install dependencies
npm run setup

# Install PM2 globally
sudo npm install -g pm2

# Build for production
npm run build:all

# Rebuild native modules (better-sqlite3) for VPS Node version
npm rebuild better-sqlite3
```

### 3.4 Environment Configuration

```bash
# Copy env template
cp .env.example .env

# Edit with your credentials
nano .env
```

**Required for production:**
- `DB_PATH` — use absolute path (e.g. `/home/predarb/pred-arb/data/pred-arb.db`)
- `API_PORT` — leave 3848 or change if behind firewall
- `LOG_LEVEL` — `info` for production, `debug` for troubleshooting

**Optional (dry-run mode works without):**
- Polymarket API keys (for live trading)
- predict.fun API keys (for live trading)

### 3.5 Create Data Directory

```bash
mkdir -p data
chmod 700 data   # Ensure only app user can access
```

### 3.6 Start with PM2

```bash
# Start using ecosystem config
pm2 start ecosystem.config.cjs

# Save PM2 process list so it survives reboot
pm2 save
pm2 startup   # Follow the printed command to enable on boot
```

### 3.7 Verify

```bash
pm2 status
pm2 logs pred-arb

# Test API
curl http://localhost:3848/api/status

# If dashboard is served: open http://YOUR_VPS_IP:3848 in browser
```

---

## 4. Optional: Nginx + SSL

If you want a domain (e.g. `predarb.yourdomain.com`) with HTTPS:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d predarb.yourdomain.com
```

Add Nginx config:

```nginx
# /etc/nginx/sites-available/predarb
server {
    listen 443 ssl;
    server_name predarb.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/predarb.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/predarb.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3848;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/predarb /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**Firewall:** Allow 80/443, optionally restrict 3848 to localhost only.

---

## 5. Maintenance Commands

| Task | Command |
|------|---------|
| View logs | `pm2 logs pred-arb` |
| Restart | `pm2 restart pred-arb` |
| Stop | `pm2 stop pred-arb` |
| Status | `pm2 status` |
| Monitor | `pm2 monit` |

---

## 6. Deploy Updates

```bash
cd /path/to/pred-arb
git pull
npm run setup          # if package.json changed
npm run build:all
npm rebuild better-sqlite3   # if Node version changed
pm2 restart pred-arb
```

---

## 7. Security Checklist

- [ ] `.env` is never committed (in `.gitignore`)
- [ ] Firewall: only allow 22 (SSH), 80, 443; block 3848 from public if using Nginx
- [ ] Run as non-root user (`predarb`)
- [ ] `chmod 600 .env` for env file
- [ ] Keep API keys in `.env` only; never in code
- [ ] Enable fail2ban for SSH (optional)

---

## 8. Troubleshooting

| Issue | Solution |
|-------|----------|
| `better_sqlite3.node` not found | `npm rebuild better-sqlite3` |
| Port 3848 in use | Change `API_PORT` in `.env` or check `lsof -i :3848` |
| DB permission denied | `chmod 700 data` and ensure app user owns it |
| PM2 not starting on reboot | Run `pm2 startup` and execute the printed command |
| Dashboard not loading | Ensure `npm run build:all` ran; check `dashboard/dist/` exists |

---

## 9. Quick Deploy Script

Use `scripts/deploy.sh` for one-command deploy/update after initial setup:

```bash
./scripts/deploy.sh
```
