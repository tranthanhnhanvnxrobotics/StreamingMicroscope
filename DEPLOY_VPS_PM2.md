# Deploy VPS with PM2 (IP only)

This guide runs both services on one VPS at `103.124.94.194` without domain.

## 1) Install runtime

```bash
apt update
apt install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt install -y nodejs
npm i -g pm2
```

## 2) Prepare backend

```bash
cd ~/WEB/backend
npm install
cp .env.vps.example .env
nano .env
```

Set at least:

- `DB_*` values for your PostgreSQL
- `SOCKET_AUTH_TOKEN` to strong random string
- Set `CONTROL_ENABLED=true`
- Set `PI_AGENT_ENABLED=true`
- Set `PI_AGENT_TOKEN` (must match Raspberry Pi)
- Keep `UART_ENABLED=false` on VPS

## 3) Prepare frontend

```bash
cd ~/WEB/frontend
npm install
cp .env.production.example .env.production
nano .env.production
npm run build
```

Ensure `NEXT_PUBLIC_SOCKET_TOKEN` matches backend `SOCKET_AUTH_TOKEN`.

## 3.1) One-place config (recommended)

Set global vars once, then auto-sync backend/frontend/nginx configs:

```bash
cd ~/WEB
cp .env.global.example .env.global
nano .env.global
```

Then generate runtime config files from this single source:

```bash
apt install -y gettext-base
bash ./deploy/scripts/sync-vps-config.sh
```

This command updates:

- `frontend/.env.production`
- `backend/.env` (creates from `.env.vps.example` if missing)
- `deploy/nginx/webapp-ip.conf` (rendered from template)

## 4) Start both services via PM2

```bash
cd ~/WEB
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root
```

Run the command shown by `pm2 startup`, then:

```bash
pm2 save
pm2 status
pm2 logs --lines 100
```

## 5) Configure Nginx reverse proxy

Use the checked-in config file:

```bash
cp ~/WEB/deploy/nginx/webapp-ip.conf /etc/nginx/sites-available/webapp
ln -sf /etc/nginx/sites-available/webapp /etc/nginx/sites-enabled/webapp
nginx -t
systemctl restart nginx
```

Optional cleanup of default site:

```bash
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
```

## 6) Useful ops

```bash
pm2 restart backend frontend
pm2 logs backend --lines 100
pm2 logs frontend --lines 100
curl -s http://127.0.0.1:5000/health
curl -I http://127.0.0.1:3000
```

## Notes about motor control

VPS has no direct UART to STM32, so this setup serves web and API online only.
To drive the motor, run lightweight Pi agent near STM32.

### Raspberry Pi agent

```bash
cd ~/WEB/backend
npm install
cp .env.pi-agent.example .env.pi-agent
nano .env.pi-agent
```

```bash
cd ~/WEB/backend
export $(grep -v '^#' .env.pi-agent | xargs)
npm run pi:agent
```
